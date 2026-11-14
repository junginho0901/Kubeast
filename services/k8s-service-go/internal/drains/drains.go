// Package drains keeps node drain progress in the database (node_drains), so
// every k8s-service replica answers a drain's status and a drain whose server
// stopped reads as interrupted.
//
// The process running a drain owns its row (Tracker.owner: host name and a
// random suffix) and refreshes the row's heartbeat every beatEvery. An open
// row whose heartbeat is staleAfter old has no live owner: the first replica
// that reads its status or sweeps marks it interrupted with one conditional
// UPDATE (of two at once one wins) and writes the drain's finished audit row.
// A process that shuts down marks its own open drains at once. The owner
// stops a drain whose row another replica marked (its beat no longer finds
// it), so "interrupted" also means nothing is evicting.
package drains

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// The states a drain goes through. pending and draining are open.
const (
	StatusPending     = "pending"
	StatusDraining    = "draining"
	StatusSuccess     = "success"
	StatusError       = "error"
	StatusInterrupted = "interrupted"
)

// Messages of an interrupted drain, in its row and its finished audit row.
const (
	MessageOwnerGone     = "the server running this drain stopped answering before it finished (the node may stay cordoned)"
	MessageOwnerShutdown = "the server running this drain shut down before it finished (the node may stay cordoned)"
)

const (
	// The owner refreshes its open rows this often; an open row whose
	// heartbeat is staleAfter old (four missed beats) reads as interrupted.
	// The drain window polls every second, so a server that dies mid-drain
	// shows as interrupted within staleAfter and a second (the 30 s line).
	beatEvery  = 5 * time.Second
	staleAfter = 20 * time.Second
	// Every replica marks the stale rows nobody is reading this often, so
	// their finished audit row is written without a window open.
	sweepEvery = 10 * time.Second
	// Finished rows are deleted keepFor after they finished; the drain's
	// history is in the audit log.
	keepFor    = 24 * time.Hour
	purgeEvery = time.Hour
	purgeBatch = 500
	opTimeout  = 5 * time.Second
)

// Row is one drain as node_drains holds it.
type Row struct {
	ID        string
	Cluster   string
	Node      string
	UserID    string
	UserEmail string
	Status    string
	Message   string
	PodsTotal *int // nil until the drain listed the node's pods
	PodsDone  *int
	Owner     string
	// Audit is the start request's audit record (no payload), from which the
	// replica that finds the drain interrupted writes its finished row.
	Audit      json.RawMessage
	StartedAt  time.Time
	UpdatedAt  time.Time
	FinishedAt *time.Time
	// Stale: open, and its heartbeat is staleAfter old by the database's clock.
	Stale bool
}

// Open says whether the drain has not ended.
func (r Row) Open() bool { return r.FinishedAt == nil }

// Progress is what a running drain writes; nil and "" keep the stored value.
type Progress struct {
	Status    string
	Message   *string
	PodsTotal *int
	PodsDone  *int
}

// Store is node_drains: PG, or Memory in tests.
type Store interface {
	Insert(ctx context.Context, r Row) error
	// Progress and Finish write only while owner holds the row and it is open.
	Progress(ctx context.Context, id, owner string, p Progress) (bool, error)
	Finish(ctx context.Context, id, owner, status, message string) (bool, error)
	// Get returns nil when there is no such drain.
	Get(ctx context.Context, id string, staleAfter time.Duration) (*Row, error)
	// Beat refreshes the heartbeat of owner's open rows and returns their ids.
	Beat(ctx context.Context, owner string) ([]string, error)
	// Interrupt marks the open rows (id, or all when id is "") whose heartbeat
	// is staleAfter old and returns those this call marked.
	Interrupt(ctx context.Context, id string, staleAfter time.Duration, message string) ([]Row, error)
	// HandOver marks owner's open rows and returns them.
	HandOver(ctx context.Context, owner, message string) ([]Row, error)
	// Purge deletes up to batch rows finished keep ago.
	Purge(ctx context.Context, keep time.Duration, batch int) (int64, error)
}

// Tracker runs this process's side: its own drains' rows and heartbeat, and
// the stale and old rows of every process.
type Tracker struct {
	store Store
	audit audit.Writer // nil: no finished rows (tests)
	owner string

	beatEvery, staleAfter, sweepEvery, purgeEvery, keep time.Duration

	mu     sync.Mutex
	active map[string]running
}

type running struct {
	cancel context.CancelFunc
	base   audit.Record
}

// NewTracker builds the tracker for this process.
func NewTracker(store Store, w audit.Writer) *Tracker {
	return &Tracker{store: store, audit: w, owner: processOwner(),
		beatEvery: beatEvery, staleAfter: staleAfter, sweepEvery: sweepEvery, purgeEvery: purgeEvery, keep: keepFor,
		active: map[string]running{}}
}

// processOwner names this process apart from every other: the host name (the
// pod's) and a random suffix.
func processOwner() string {
	id := uuid.NewString()[:8]
	if host, err := os.Hostname(); err == nil && host != "" {
		return host + "/" + id
	}
	return id
}

// Begin stores a new drain owned by this process. cancel stops the drain when
// another replica marks its row; base is the start request's audit record.
func (t *Tracker) Begin(ctx context.Context, r Row, base audit.Record, cancel context.CancelFunc) error {
	base.Before, base.After, base.Result, base.Error = nil, nil, "", ""
	b, err := json.Marshal(base)
	if err != nil {
		return err
	}
	r.Owner, r.Status, r.Audit = t.owner, StatusPending, b
	if err := t.store.Insert(ctx, r); err != nil {
		return err
	}
	t.mu.Lock()
	t.active[r.ID] = running{cancel: cancel, base: base}
	t.mu.Unlock()
	return nil
}

// Progress writes what the drain is doing; a failure is logged and the drain
// goes on.
func (t *Tracker) Progress(id string, p Progress) {
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	if _, err := t.store.Progress(ctx, id, t.owner, p); err != nil {
		slog.Warn("drain: progress not saved", "id", id, "err", err)
	}
}

// Finish writes the drain's end and, when this process still held it, its
// finished audit row. It reports whether the row took the end: false when
// another replica marked it interrupted first (and wrote that row). When the
// end cannot be saved the audit row is still written, since the drain did end
// here; the row, no longer beaten, reads as interrupted later.
func (t *Tracker) Finish(id, status, message string) bool {
	t.mu.Lock()
	run, ok := t.active[id]
	delete(t.active, id)
	t.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	applied, err := t.store.Finish(ctx, id, t.owner, status, message)
	if err != nil {
		slog.Warn("drain: end not saved", "id", id, "status", status, "err", err)
	}
	if ok && (applied || err != nil) {
		t.recordEnd(context.Background(), run.base, id, status, message)
	}
	return applied
}

// Status reads a drain from any replica. A stale open row is marked
// interrupted here (of two replicas reading at once, one marks it) and read
// as it now is. The mark and its audit row do not follow the request's
// cancellation: a caller that goes away between them would leave a marked
// row with no finished row, which no sweep writes later.
func (t *Tracker) Status(ctx context.Context, id string) (*Row, error) {
	r, err := t.store.Get(ctx, id, t.staleAfter)
	if err != nil || r == nil || !r.Stale {
		return r, err
	}
	mctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), opTimeout)
	defer cancel()
	marked, err := t.store.Interrupt(mctx, id, t.staleAfter, MessageOwnerGone)
	if err != nil {
		return nil, err
	}
	t.recordInterrupted(context.WithoutCancel(ctx), marked)
	if len(marked) == 1 {
		return &marked[0], nil
	}
	// another replica marked it, or its owner beat in between
	return t.store.Get(ctx, id, t.staleAfter)
}

// Run beats for this process's drains, marks stale rows and deletes old ones
// until ctx ends. The heartbeat has a goroutine of its own, so a slow sweep or
// purge cannot hold it past staleAfter.
func (t *Tracker) Run(ctx context.Context) {
	go t.beatLoop(ctx)
	sweep, purge := time.NewTicker(t.sweepEvery), time.NewTicker(t.purgeEvery)
	defer sweep.Stop()
	defer purge.Stop()
	t.purge(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			t.sweep(ctx)
		case <-purge.C:
			t.purge(ctx)
		}
	}
}

func (t *Tracker) beatLoop(ctx context.Context) {
	beat := time.NewTicker(t.beatEvery)
	defer beat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-beat.C:
			t.beat(ctx)
		}
	}
}

// beat refreshes this process's open rows and stops each drain whose row it
// no longer finds open: another replica marked it while this process could
// not beat.
func (t *Tracker) beat(ctx context.Context) {
	t.mu.Lock()
	ids := make([]string, 0, len(t.active))
	for id := range t.active {
		ids = append(ids, id)
	}
	t.mu.Unlock()
	if len(ids) == 0 {
		return
	}
	bctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	held, err := t.store.Beat(bctx, t.owner)
	if err != nil {
		slog.Warn("drain: heartbeat", "err", err)
		return
	}
	still := make(map[string]bool, len(held))
	for _, id := range held {
		still[id] = true
	}
	for _, id := range ids {
		if still[id] {
			continue
		}
		t.mu.Lock()
		run, ok := t.active[id]
		delete(t.active, id)
		t.mu.Unlock()
		if ok {
			slog.Warn("drain: another server marked this drain interrupted; stopping it", "id", id)
			run.cancel()
		}
	}
}

// sweep marks the stale rows nobody is reading. As in Status, the mark and
// its audit rows do not follow ctx's cancellation.
func (t *Tracker) sweep(ctx context.Context) {
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), opTimeout)
	defer cancel()
	marked, err := t.store.Interrupt(sctx, "", t.staleAfter, MessageOwnerGone)
	if err != nil {
		slog.Warn("drain: marking stale drains", "err", err)
		return
	}
	t.recordInterrupted(context.WithoutCancel(ctx), marked)
}

func (t *Tracker) purge(ctx context.Context) {
	for ctx.Err() == nil {
		pctx, cancel := context.WithTimeout(ctx, opTimeout)
		n, err := t.store.Purge(pctx, t.keep, purgeBatch)
		cancel()
		if err != nil {
			slog.Warn("drain: deleting finished drains", "err", err)
			return
		}
		if n < purgeBatch {
			return
		}
	}
}

// Shutdown marks this process's open drains interrupted, writes their
// finished audit rows and stops them, all within ctx's deadline (the time
// the pod's grace period leaves it).
func (t *Tracker) Shutdown(ctx context.Context) {
	t.mu.Lock()
	runs := t.active
	t.active = map[string]running{}
	t.mu.Unlock()
	if len(runs) == 0 {
		return
	}
	marked, err := t.store.HandOver(ctx, t.owner, MessageOwnerShutdown)
	if err != nil {
		slog.Warn("drain: marking this server's drains at shutdown", "err", err)
	}
	for _, run := range runs {
		run.cancel()
	}
	t.recordInterrupted(ctx, marked)
}

func (t *Tracker) recordInterrupted(ctx context.Context, rows []Row) {
	for _, r := range rows {
		var base audit.Record
		if err := json.Unmarshal(r.Audit, &base); err != nil || len(r.Audit) == 0 {
			base = audit.Record{Service: audit.ServiceK8s, Action: "k8s.node.drain", ActorUserID: r.UserID, ActorEmail: r.UserEmail,
				TargetType: "node", TargetID: r.Node, Cluster: r.Cluster}
		}
		base.Before = nil // stored as JSON null
		slog.Warn("drain: interrupted", "id", r.ID, "node", r.Node, "cluster", r.Cluster, "previous_owner", r.Owner)
		t.recordEnd(ctx, base, r.ID, StatusInterrupted, r.Message)
	}
}

// recordEnd writes the drain's finished row with the start request's actor
// and address (base): failure unless every pod was evicted. It waits at most
// opTimeout, and no longer than ctx allows.
func (t *Tracker) recordEnd(ctx context.Context, base audit.Record, id, status, message string) {
	if t.audit == nil {
		return
	}
	rec := base
	rec.After = audit.MustJSON(map[string]interface{}{"drain_id": id, "phase": "finished", "status": status, "message": message})
	rec.Result = audit.ResultSuccess
	if status != StatusSuccess {
		rec.Result, rec.Error = audit.ResultFailure, message
	}
	wctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	_, _ = t.audit.Write(wctx, rec) // audit.Guarded counts a failure
}
