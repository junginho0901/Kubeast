package recording

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Meta describes a recorded terminal.
type Meta struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"` // exec | node-shell
	UserID    string    `json:"user_id"`
	UserEmail string    `json:"user_email"`
	Cluster   string    `json:"cluster"`
	Namespace string    `json:"namespace"`
	Target    string    `json:"target"`
	Container string    `json:"container,omitempty"`
	StartedAt time.Time `json:"started_at"`
	Width     int       `json:"-"`
	Height    int       `json:"-"`
}

const (
	partMaxBytes = 8 << 20
	maxBackoff   = 5 * time.Minute
	// an unreachable store must fail a part, not hold the uploader for every session
	partPutTimeout = 30 * time.Second

	// The owner of a recording refreshes its row's heartbeat this often; a row
	// whose heartbeat is ownerStaleAfter old (four missed beats) has no live
	// owner. Every recoverEvery each recorder takes such rows.
	heartbeatEvery  = 15 * time.Second
	ownerStaleAfter = time.Minute
	recoverEvery    = 30 * time.Second
	beatTimeout     = 5 * time.Second
	// A row written before rows had owners is taken once this process has run
	// this long: a rolling update stops the old pod within its grace period
	// after the new one is ready.
	unownedAfter = 5 * time.Minute
)

type tracked struct {
	meta        Meta
	location    string
	path        string
	offset      int64
	parts       int
	ended       bool
	interrupted bool
	truncated   bool
	nextTry     time.Time
	backoff     time.Duration
	session     *Session
}

// Manager starts recordings and uploads their parts. A nil or disabled
// manager records nothing.
type Manager struct {
	cfg        Config
	store      Store
	pool       *pgxpool.Pool
	rows       index
	owner      string // this process in the rows it writes: host name and a random suffix
	started    time.Time
	now        func() time.Time
	putTimeout time.Duration

	beatEvery, staleAfter, recoverEvery, unownedAfter time.Duration

	mu       sync.Mutex
	active   map[string]*tracked
	wake     chan struct{}
	flushing chan struct{} // one slot: the flush, recovery or hand-over that holds it

	beatMu     sync.Mutex
	handedOver bool // under beatMu: Shutdown gave this process's rows up, no more beats

	failures    atomic.Int64
	uploaded    atomic.Int64
	lastSuccess atomic.Int64
}

// New builds the manager; with recording off it returns a disabled manager.
func New(cfg Config, pool *pgxpool.Pool) (*Manager, error) {
	m := &Manager{cfg: cfg, pool: pool, rows: pgIndex{pool}, owner: processOwner(), now: time.Now, putTimeout: partPutTimeout,
		beatEvery: heartbeatEvery, staleAfter: ownerStaleAfter, recoverEvery: recoverEvery, unownedAfter: unownedAfter,
		active: map[string]*tracked{}, wake: make(chan struct{}, 1), flushing: make(chan struct{}, 1)}
	m.started = m.now()
	if !cfg.Enabled {
		return m, nil
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	st, err := newStore(cfg, pool)
	if err != nil {
		return nil, err
	}
	m.store = st
	m.lastSuccess.Store(time.Now().Unix())
	return m, nil
}

// processOwner names this process apart from every other, the pod's earlier
// containers too: the host name (the pod's) and a random suffix.
func processOwner() string {
	id := uuid.NewString()[:8]
	if host, err := os.Hostname(); err == nil && host != "" {
		return host + "/" + id
	}
	return id
}

func (m *Manager) Enabled() bool  { return m != nil && m.cfg.Enabled }
func (m *Manager) Required() bool { return m != nil && m.cfg.Required }

// Start opens a recording for meta (ID and StartedAt are filled in). The
// banner is the first thing the recording holds.
func (m *Manager) Start(ctx context.Context, meta Meta) (*Session, error) {
	if !m.Enabled() {
		return nil, errors.New("session recording is off")
	}
	meta.ID = uuid.NewString()
	meta.StartedAt = m.now().UTC()
	if err := os.MkdirAll(m.cfg.SpoolDir, 0o750); err != nil {
		return nil, fmt.Errorf("recording spool: %w", err)
	}
	path := filepath.Join(m.cfg.SpoolDir, meta.ID+".cast")
	title := fmt.Sprintf("%s %s/%s on %s by %s", meta.Kind, meta.Namespace, meta.Target, meta.Cluster, meta.UserEmail)
	s, err := newSession(meta.ID, path, meta.Width, meta.Height, title, m.cfg.effectiveMaxBytes(), m.now)
	if err != nil {
		return nil, fmt.Errorf("recording spool: %w", err)
	}
	location := m.store.Location(meta)
	if err := m.rows.insert(ctx, meta, m.cfg.Storage, location, m.owner); err != nil {
		s.Close()
		_ = os.Remove(path)
		return nil, fmt.Errorf("recording index: %w", err)
	}
	t := &tracked{meta: meta, location: location, path: path, session: s}
	s.onClose = m.ended
	m.mu.Lock()
	m.active[meta.ID] = t
	m.mu.Unlock()
	return s, nil
}

// Abort drops a recording whose session never started (e.g. the audit row
// could not be written).
func (m *Manager) Abort(s *Session) {
	if m == nil || s == nil {
		return
	}
	m.mu.Lock()
	t := m.active[s.ID]
	delete(m.active, s.ID)
	m.mu.Unlock()
	s.onClose = nil
	s.Close()
	if t != nil {
		_ = os.Remove(t.path)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = m.rows.remove(ctx, s.ID)
}

func (m *Manager) ended(s *Session) {
	m.mu.Lock()
	t := m.active[s.ID]
	if t != nil {
		t.ended = true
		t.truncated = s.Truncated()
	}
	m.mu.Unlock()
	if t == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	size := fileSize(t.path)
	_ = m.rows.ended(ctx, s.ID, size, t.truncated)
	m.kick()
}

func (m *Manager) kick() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// Run keeps this process's rows alive, takes over the recordings no live
// process holds (at start and every recoverEvery), and uploads parts every
// ChunkSeconds and whenever a session ends, until ctx ends.
func (m *Manager) Run(ctx context.Context) {
	if !m.Enabled() {
		return
	}
	beating := make(chan struct{})
	go func() {
		defer close(beating)
		m.keepAlive(ctx)
	}()
	defer func() { <-beating }()
	m.recover(ctx)
	t := time.NewTicker(time.Duration(m.cfg.ChunkSeconds) * time.Second)
	defer t.Stop()
	look := time.NewTicker(m.recoverEvery)
	defer look.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-look.C:
			m.recover(ctx)
			continue
		case <-t.C:
		case <-m.wake:
		}
		m.flush(ctx)
	}
}

// keepAlive refreshes the heartbeat of the rows this process holds, on its
// own goroutine so that a flush waiting on a slow store does not hold it back.
func (m *Manager) keepAlive(ctx context.Context) {
	t := time.NewTicker(m.beatEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.beat(ctx)
		}
	}
}

func (m *Manager) beat(ctx context.Context) {
	m.beatMu.Lock()
	defer m.beatMu.Unlock()
	if m.handedOver {
		return
	}
	m.mu.Lock()
	n := len(m.active)
	m.mu.Unlock()
	if n == 0 {
		return
	}
	bctx, cancel := context.WithTimeout(ctx, beatTimeout)
	defer cancel()
	if err := m.rows.beat(bctx, m.owner); err != nil {
		slog.Warn("recording: heartbeat", "err", err)
	}
}

// Shutdown ends live recordings and uploads what is left, within ctx. Those
// sessions were cut off by the server, so they end as interrupted.
func (m *Manager) Shutdown(ctx context.Context) {
	if !m.Enabled() {
		return
	}
	m.mu.Lock()
	var live []*Session
	for _, t := range m.active {
		if !t.ended && t.session != nil {
			t.interrupted = true
			live = append(live, t.session)
		}
	}
	m.mu.Unlock()
	for _, s := range live {
		s.Close()
	}
	m.flush(ctx)
	m.handOver(ctx)
}

// handOver clears the heartbeat of this process's rows still open (an upload
// that failed or ran out of time), so another recorder takes them at its next
// look instead of after staleAfter. It keeps the flush slot: nothing of this
// process uploads, takes a row or beats after it. A flush still under way when
// ctx ends keeps the rows, and they go stale instead.
func (m *Manager) handOver(ctx context.Context) {
	select {
	case m.flushing <- struct{}{}:
	case <-ctx.Done():
		return
	}
	m.beatMu.Lock()
	defer m.beatMu.Unlock()
	m.handedOver = true
	if err := m.rows.handOver(ctx, m.owner); err != nil {
		slog.Warn("recording: hand-over", "err", err)
	}
}

// recover takes the rows of recordings no live process holds and returns how
// many it took. Taking one is a conditional update on the owner and heartbeat
// it read, so of two recorders looking at once one gets it. A recording whose
// spool file this process holds is uploaded, and marked interrupted if it was
// still recording (the session was cut off); one whose file is elsewhere is
// closed out with the parts uploaded before.
func (m *Manager) recover(ctx context.Context) int {
	select {
	case m.flushing <- struct{}{}:
	case <-ctx.Done():
		return 0
	}
	defer func() { <-m.flushing }()
	open, now, err := m.rows.open(ctx)
	if err != nil {
		slog.Warn("recording: recovery query", "err", err)
		return 0
	}
	taken := 0
	for _, r := range open {
		if !m.takeable(r, now) {
			continue
		}
		ok, err := m.rows.take(ctx, r, m.owner)
		if err != nil {
			slog.Warn("recording: taking a recording over", "id", r.id, "err", err)
		}
		if !ok {
			continue
		}
		taken++
		t := &tracked{
			meta:     Meta{ID: r.id, Kind: r.kind, Cluster: r.cluster, Target: r.target, StartedAt: r.startedAt},
			location: r.location, offset: r.uploaded, parts: r.parts,
			path: filepath.Join(m.cfg.SpoolDir, r.id+".cast"), ended: true, interrupted: r.status == "recording",
		}
		if _, err := os.Stat(t.path); err != nil {
			_ = m.rows.lost(ctx, r.id, m.owner)
			continue
		}
		if t.interrupted {
			_ = m.rows.cutOff(ctx, r.id, fileSize(t.path))
		}
		m.mu.Lock()
		m.active[r.id] = t
		m.mu.Unlock()
		slog.Info("recording: resuming upload left by another process", "id", r.id, "interrupted", t.interrupted, "previous_owner", r.owner)
	}
	return taken
}

// takeable: a row no live process holds. Its owner handed it over at
// shutdown (no heartbeat) or stopped beating staleAfter ago; a row written
// before rows had owners waits until this process has run unownedAfter. A row
// this process holds is never taken, also when another took it from it.
func (m *Manager) takeable(r openRow, now time.Time) bool {
	m.mu.Lock()
	_, held := m.active[r.id]
	m.mu.Unlock()
	switch {
	case held || r.owner == m.owner:
		return false
	case r.owner == "":
		return m.now().Sub(m.started) >= m.unownedAfter
	case r.heartbeat == nil:
		return true
	default:
		return now.Sub(*r.heartbeat) >= m.staleAfter
	}
}

// flush uploads every tracked recording's new bytes as parts. A live
// recording uploads whole lines only; an ended one uploads the rest and is
// closed out. One runs at a time: Run's and Shutdown's would both send the
// same part and count it twice.
func (m *Manager) flush(ctx context.Context) {
	select {
	case m.flushing <- struct{}{}:
	case <-ctx.Done():
		return
	}
	defer func() { <-m.flushing }()
	m.mu.Lock()
	list := make([]*tracked, 0, len(m.active))
	for _, t := range m.active {
		list = append(list, t)
	}
	m.mu.Unlock()
	now := m.now()
	for _, t := range list {
		if now.Before(t.nextTry) {
			continue
		}
		m.mu.Lock()
		ended := t.ended
		m.mu.Unlock()
		if err := m.uploadNew(ctx, t, ended); err != nil {
			m.failures.Add(1)
			if t.backoff == 0 {
				t.backoff = time.Duration(m.cfg.ChunkSeconds) * time.Second
			} else if t.backoff *= 2; t.backoff > maxBackoff {
				t.backoff = maxBackoff
			}
			t.nextTry = now.Add(t.backoff)
			_ = m.rows.failed(ctx, t.meta.ID, truncateErr(err))
			slog.Warn("recording: upload failed; retrying", "id", t.meta.ID, "err", err, "retry_in", t.backoff.String())
			continue
		}
		t.backoff, t.nextTry = 0, time.Time{}
		if ended && t.offset >= fileSize(t.path) {
			status := "uploaded"
			if t.interrupted {
				status = "interrupted"
			}
			_ = m.rows.finished(ctx, t.meta.ID, status)
			_ = os.Remove(t.path)
			m.mu.Lock()
			delete(m.active, t.meta.ID)
			m.mu.Unlock()
		}
	}
}

func (m *Manager) uploadNew(ctx context.Context, t *tracked, ended bool) error {
	f, err := os.Open(t.path)
	if err != nil {
		return err
	}
	defer f.Close()
	for {
		st, err := f.Stat()
		if err != nil {
			return err
		}
		if t.offset >= st.Size() {
			return nil
		}
		n := st.Size() - t.offset
		if n > partMaxBytes {
			n = partMaxBytes
		}
		buf := make([]byte, n)
		if _, err := f.ReadAt(buf, t.offset); err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if !ended || n == partMaxBytes {
			// whole lines only, so every part is a run of complete events
			cut := bytes.LastIndexByte(buf, '\n')
			if cut < 0 {
				return nil
			}
			buf = buf[:cut+1]
		}
		if len(buf) == 0 {
			return nil
		}
		putCtx, cancel := context.WithTimeout(ctx, m.putTimeout)
		err = m.store.PutPart(putCtx, t.location, t.parts, buf)
		cancel()
		if err != nil {
			return err
		}
		// under mu for PendingBytes; flush is the only writer
		m.mu.Lock()
		t.offset += int64(len(buf))
		t.parts++
		m.mu.Unlock()
		m.uploaded.Add(int64(len(buf)))
		m.lastSuccess.Store(m.now().Unix())
		if err := m.rows.uploaded(ctx, t.meta.ID, t.offset, t.parts, ended); err != nil {
			return err
		}
	}
}

// PendingBytes is what is recorded locally but not uploaded yet.
func (m *Manager) PendingBytes() int64 {
	if !m.Enabled() {
		return 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for _, t := range m.active {
		if d := fileSize(t.path) - t.offset; d > 0 {
			n += d
		}
	}
	return n
}

func (m *Manager) Failures() int64      { return m.failures.Load() }
func (m *Manager) LastSuccess() int64   { return m.lastSuccess.Load() }
func (m *Manager) UploadedBytes() int64 { return m.uploaded.Load() }

func fileSize(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.Size()
}

func truncateErr(err error) string {
	s := err.Error()
	if len(s) > 1000 {
		s = s[:1000]
	}
	return s
}
