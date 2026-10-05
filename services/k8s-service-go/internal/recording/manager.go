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
	now        func() time.Time
	putTimeout time.Duration

	mu     sync.Mutex
	active map[string]*tracked
	wake   chan struct{}

	failures    atomic.Int64
	uploaded    atomic.Int64
	lastSuccess atomic.Int64
}

// New builds the manager; with recording off it returns a disabled manager.
func New(cfg Config, pool *pgxpool.Pool) (*Manager, error) {
	m := &Manager{cfg: cfg, pool: pool, now: time.Now, putTimeout: partPutTimeout, active: map[string]*tracked{}, wake: make(chan struct{}, 1)}
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
	if _, err := m.pool.Exec(ctx, `
		INSERT INTO session_recordings (id, kind, user_id, user_email, cluster, namespace, target, container, storage, location, started_at, status)
		VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), $5, NULLIF($6,''), $7, NULLIF($8,''), $9, $10, $11, 'recording')`,
		meta.ID, meta.Kind, meta.UserID, meta.UserEmail, meta.Cluster, meta.Namespace, meta.Target, meta.Container, m.cfg.Storage, location, meta.StartedAt); err != nil {
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
	_, _ = m.pool.Exec(ctx, `DELETE FROM session_recordings WHERE id = $1`, s.ID)
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
	_, _ = m.pool.Exec(ctx, `UPDATE session_recordings SET ended_at = NOW(), bytes = $2, truncated = $3, status = 'uploading', updated_at = NOW() WHERE id = $1`, s.ID, size, t.truncated)
	m.kick()
}

func (m *Manager) kick() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// Run recovers recordings left by a previous process, then uploads parts
// every ChunkSeconds and whenever a session ends, until ctx ends.
func (m *Manager) Run(ctx context.Context) {
	if !m.Enabled() {
		return
	}
	m.recover(ctx)
	t := time.NewTicker(time.Duration(m.cfg.ChunkSeconds) * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-m.wake:
		}
		m.flush(ctx)
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
}

// recover picks up rows a previous process left mid-way: the spool file is
// uploaded and the recording marked interrupted (the session was cut off).
func (m *Manager) recover(ctx context.Context) {
	rows, err := m.pool.Query(ctx, `SELECT id, kind, cluster, target, location, uploaded_bytes, parts, status, started_at FROM session_recordings WHERE status IN ('recording', 'uploading')`)
	if err != nil {
		slog.Warn("recording: recovery query", "err", err)
		return
	}
	var found []*tracked
	for rows.Next() {
		var t tracked
		var status string
		if err := rows.Scan(&t.meta.ID, &t.meta.Kind, &t.meta.Cluster, &t.meta.Target, &t.location, &t.offset, &t.parts, &status, &t.meta.StartedAt); err != nil {
			continue
		}
		t.path = filepath.Join(m.cfg.SpoolDir, t.meta.ID+".cast")
		t.ended = true
		t.interrupted = status == "recording"
		found = append(found, &t)
	}
	rows.Close()
	for _, t := range found {
		if _, err := os.Stat(t.path); err != nil {
			_, _ = m.pool.Exec(ctx, `UPDATE session_recordings SET status = 'interrupted', ended_at = COALESCE(ended_at, NOW()), bytes = GREATEST(bytes, uploaded_bytes), last_error = 'spool file lost; parts uploaded before are kept', updated_at = NOW() WHERE id = $1`, t.meta.ID)
			continue
		}
		if t.interrupted {
			_, _ = m.pool.Exec(ctx, `UPDATE session_recordings SET ended_at = COALESCE(ended_at, NOW()), bytes = $2, updated_at = NOW() WHERE id = $1`, t.meta.ID, fileSize(t.path))
		}
		m.mu.Lock()
		m.active[t.meta.ID] = t
		m.mu.Unlock()
		slog.Info("recording: resuming upload left by the previous process", "id", t.meta.ID, "interrupted", t.interrupted)
	}
}

// flush uploads every tracked recording's new bytes as parts. A live
// recording uploads whole lines only; an ended one uploads the rest and is
// closed out.
func (m *Manager) flush(ctx context.Context) {
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
			_, _ = m.pool.Exec(ctx, `UPDATE session_recordings SET last_error = $2, updated_at = NOW() WHERE id = $1`, t.meta.ID, truncateErr(err))
			slog.Warn("recording: upload failed; retrying", "id", t.meta.ID, "err", err, "retry_in", t.backoff.String())
			continue
		}
		t.backoff, t.nextTry = 0, time.Time{}
		if ended && t.offset >= fileSize(t.path) {
			status := "uploaded"
			if t.interrupted {
				status = "interrupted"
			}
			_, _ = m.pool.Exec(ctx, `UPDATE session_recordings SET status = $2, last_error = NULL, updated_at = NOW() WHERE id = $1`, t.meta.ID, status)
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
		t.offset += int64(len(buf))
		t.parts++
		m.uploaded.Add(int64(len(buf)))
		m.lastSuccess.Store(m.now().Unix())
		status := "recording"
		if ended {
			status = "uploading"
		}
		if _, err := m.pool.Exec(ctx, `UPDATE session_recordings SET uploaded_bytes = $2, parts = $3, status = CASE WHEN status = 'recording' THEN $4 ELSE status END, last_error = NULL, updated_at = NOW() WHERE id = $1`,
			t.meta.ID, t.offset, t.parts, status); err != nil {
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
