// Package nodeshells keeps a row per open node shell in the database
// (node_shells), so that the pod of a shell whose server was killed is deleted
// by another server instead of running until its deadline.
//
// The owner rule is the drains' (#858) and the recordings' (#851): the process
// that opens a shell owns its row (Tracker.owner: host name and a random
// suffix) and refreshes the row's heartbeat every beatEvery. A row whose
// heartbeat is staleAfter old has no live owner: a replica sweeping takes it
// with one conditional UPDATE (of two at once one wins), deletes the shell's
// pod as the person who opened it, and deletes the row. A replica judges so
// only when its own database calls have answered without a break for
// staleAfter: a pause of the database stops every heartbeat at once, and the
// owners beat again before anyone may judge. A row the process tracks is never
// taken by it.
//
// A pod is deleted only when its label names the row, and only that pod (its
// UID read just before). When the cluster cannot be reached, the row is left
// as taken and not beaten: it goes stale again and a later sweep, on any
// replica, tries once more.
package nodeshells

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The pod's label naming its row, and its annotation naming the server that opened it.
const (
	LabelID         = "kubeast.io/node-shell-id"
	AnnotationOwner = "kubeast.io/node-shell-owner"
)

// ReasonServerGone is after.reason of the k8s.session.end row a sweep writes.
const ReasonServerGone = "server_gone"

const (
	// The owner refreshes its rows this often; a row whose heartbeat is
	// staleAfter old (four missed beats) has no live owner. A recording's
	// numbers (#851): nobody waits on a screen for this.
	beatEvery  = 15 * time.Second
	staleAfter = 60 * time.Second
	// A run of database contact breaks at a gap longer than contactGap
	// between answered calls (the drains' rule).
	contactGap = staleAfter - beatEvery
	// Every replica with node shell on looks for rows without an owner this
	// often, the first time when it starts.
	sweepEvery = 30 * time.Second
	takeBatch  = 20
	opTimeout  = 5 * time.Second
	// removeTimeout bounds one pod deletion in a target cluster.
	removeTimeout = 10 * time.Second
)

// Row is one open node shell as node_shells holds it.
type Row struct {
	ID        string
	Cluster   string
	Namespace string
	Pod       string
	Node      string
	Owner     string
	// Person is the opener's claims for this cluster (PersonFor): the pod is
	// deleted as them, as the shell's own cleanup does.
	Person json.RawMessage
	// Audit is the opening request's audit record (no payload), from which
	// the sweep writes the shell's k8s.session.end row.
	Audit    json.RawMessage
	OpenedAt time.Time
}

// Store is node_shells: PG, or Memory in tests.
type Store interface {
	Insert(ctx context.Context, r Row) error
	// Beat refreshes the heartbeat of owner's rows among ids and returns those it found.
	Beat(ctx context.Context, owner string, ids []string) ([]string, error)
	// Take gives owner up to limit rows whose heartbeat is staleAfter old,
	// none of skip, with a fresh heartbeat, and returns them with the owner
	// they had before.
	Take(ctx context.Context, owner string, staleAfter time.Duration, skip []string, limit int) ([]Row, error)
	// Remove deletes the row while owner holds it.
	Remove(ctx context.Context, id, owner string) error
	// Ping is a call that only checks the database answers.
	Ping(ctx context.Context) error
}

// Remover deletes a row's pod in its cluster. deleted is false when there was
// no pod of that row to delete; an error leaves the row to a later sweep.
type Remover func(ctx context.Context, r Row) (deleted bool, err error)

// Tracker runs this process's side: its own shells' rows and heartbeat, and
// the rows whose owner is gone.
type Tracker struct {
	store  Store
	remove Remover
	audit  audit.Writer // nil: no rows (tests)
	owner  string
	now    func() time.Time

	beatEvery, staleAfter, contactGap, sweepEvery time.Duration

	mu     sync.Mutex
	active map[string]bool
	// The run of answered database calls this process is in: since when, and
	// the last one (zero since: broken).
	contactSince, contactLast time.Time
}

// NewTracker builds the tracker for this process.
func NewTracker(store Store, remove Remover, w audit.Writer) *Tracker {
	return &Tracker{store: store, remove: remove, audit: w, owner: processOwner(), now: time.Now,
		beatEvery: beatEvery, staleAfter: staleAfter, contactGap: contactGap, sweepEvery: sweepEvery,
		active: map[string]bool{}}
}

// processOwner names this process apart from every other: the host name (the
// pod's) and a random suffix, as the drains' owner.
func processOwner() string {
	id := uuid.NewString()[:8]
	if host, err := os.Hostname(); err == nil && host != "" {
		return host + "/" + id
	}
	return id
}

// Owner is the name this process writes in its rows and on its pods.
func (t *Tracker) Owner() string { return t.owner }

// NewID names a new shell's row (a valid label value).
func NewID() string { return uuid.NewString() }

// PersonFor keeps what acting as p in clusterID reads: who, and the
// permissions, role and namespaces of "*" and of that cluster.
func PersonFor(p auth.TokenPayload, clusterID string) json.RawMessage {
	q := auth.TokenPayload{UserID: p.UserID, Email: p.Email, System: p.System}
	for _, key := range []string{"*", clusterID} {
		if v, ok := p.Perms[key]; ok {
			if q.Perms == nil {
				q.Perms = auth.PermissionMatrix{}
			}
			q.Perms[key] = v
		}
	}
	if v, ok := p.Roles[clusterID]; ok {
		q.Roles = map[string]string{clusterID: v}
	}
	if v, ok := p.Namespaces[clusterID]; ok {
		q.Namespaces = map[string][]string{clusterID: v}
	}
	b, _ := json.Marshal(q)
	return b
}

// Begin stores a new shell owned by this process, before its pod is made;
// base is the opening request's audit record.
func (t *Tracker) Begin(ctx context.Context, r Row, base audit.Record) error {
	base.Before, base.After, base.Result, base.Error = nil, nil, "", ""
	b, err := json.Marshal(base)
	if err != nil {
		return err
	}
	r.Owner, r.Audit = t.owner, b
	err = t.store.Insert(ctx, r)
	t.answered(err)
	if err != nil {
		return err
	}
	t.mu.Lock()
	t.active[r.ID] = true
	t.mu.Unlock()
	return nil
}

// End deletes the row of a shell whose pod is gone (deleted, or never made).
func (t *Tracker) End(id string) {
	t.mu.Lock()
	delete(t.active, id)
	t.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	err := t.store.Remove(ctx, id, t.owner)
	t.answered(err)
	if err != nil {
		slog.Warn("node shell: row not deleted; it goes stale and a sweep deletes it", "id", id, "err", err)
	}
}

// Release stops beating a shell whose pod could not be deleted: its row goes
// stale and a sweep deletes the pod.
func (t *Tracker) Release(id string) {
	t.mu.Lock()
	delete(t.active, id)
	t.mu.Unlock()
}

// answered notes how a database call that just ended went: a failure breaks
// this process's run of contact, and so does a gap longer than contactGap.
func (t *Tracker) answered(err error) {
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	if err != nil {
		t.contactSince = time.Time{}
		return
	}
	if t.contactSince.IsZero() || now.Sub(t.contactLast) > t.contactGap {
		t.contactSince = now
	}
	t.contactLast = now
}

// inContact says whether this process's database calls have answered without
// a break for staleAfter, so that a row staleAfter old is its owner's silence
// and not the database's.
func (t *Tracker) inContact() bool {
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.contactSince.IsZero() && now.Sub(t.contactLast) <= t.contactGap && now.Sub(t.contactSince) >= t.staleAfter
}

func (t *Tracker) activeIDs() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	ids := make([]string, 0, len(t.active))
	for id := range t.active {
		ids = append(ids, id)
	}
	return ids
}

// Run beats for this process's shells and sweeps, the first time at once,
// until ctx ends. The heartbeat has a goroutine of its own, so a slow sweep
// cannot hold it past staleAfter.
func (t *Tracker) Run(ctx context.Context) {
	go t.beatLoop(ctx)
	sweep := time.NewTicker(t.sweepEvery)
	defer sweep.Stop()
	t.sweep(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			t.sweep(ctx)
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

// beat refreshes this process's rows. A row it no longer finds was taken by
// another replica, which deletes its pod: the shell ends with it.
func (t *Tracker) beat(ctx context.Context) {
	ids := t.activeIDs()
	if len(ids) == 0 {
		return
	}
	bctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	held, err := t.store.Beat(bctx, t.owner, ids)
	t.answered(err)
	if err != nil {
		slog.Warn("node shell: heartbeat", "err", err)
		return
	}
	if len(held) < len(ids) {
		slog.Warn("node shell: another server took rows of this server's shells", "rows", len(ids), "found", len(held))
	}
}

// sweep deletes the pods of rows whose owner is gone, when this replica has
// been in contact with the database for staleAfter; until then it only checks
// the database answers, which keeps the run of contact going.
func (t *Tracker) sweep(ctx context.Context) {
	sctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	if !t.inContact() {
		t.answered(t.store.Ping(sctx))
		return
	}
	taken, err := t.store.Take(sctx, t.owner, t.staleAfter, t.activeIDs(), takeBatch)
	t.answered(err)
	if err != nil {
		slog.Warn("node shell: reading the shells of stopped servers", "err", err)
		return
	}
	for _, r := range taken {
		if ctx.Err() != nil {
			return
		}
		t.clean(ctx, r)
	}
}

// clean deletes a taken row's pod, then the row, and writes the shell's end.
// The row and the audit row do not follow ctx's cancellation once the pod is
// gone.
func (t *Tracker) clean(ctx context.Context, r Row) {
	rctx, cancel := context.WithTimeout(ctx, removeTimeout)
	deleted, err := t.remove(rctx, r)
	cancel()
	if err != nil {
		slog.Warn("node shell: pod of a stopped server not deleted; a later sweep tries again",
			"pod", r.Pod, "namespace", r.Namespace, "cluster", r.Cluster, "err", err)
		return
	}
	slog.Info("node shell: pod of a stopped server deleted", "pod", r.Pod, "namespace", r.Namespace,
		"cluster", r.Cluster, "previous_owner", r.Owner, "deleted", deleted)
	dctx, dcancel := context.WithTimeout(context.WithoutCancel(ctx), opTimeout)
	err = t.store.Remove(dctx, r.ID, t.owner)
	dcancel()
	t.answered(err)
	if err != nil {
		slog.Warn("node shell: row not deleted; a later sweep finds no pod and deletes it", "id", r.ID, "err", err)
	}
	t.recordEnd(context.WithoutCancel(ctx), r, deleted)
}

// recordEnd writes the k8s.session.end row the killed server could not, with
// the opening request's actor and address.
func (t *Tracker) recordEnd(ctx context.Context, r Row, deleted bool) {
	if t.audit == nil {
		return
	}
	var rec audit.Record
	if err := json.Unmarshal(r.Audit, &rec); err != nil || len(r.Audit) == 0 {
		rec = audit.Record{Service: audit.ServiceK8s, TargetType: "node", TargetID: r.Node, Cluster: r.Cluster, Namespace: r.Namespace}
	}
	rec.Action = "k8s.session.end"
	rec.Before = nil
	rec.After = audit.MustJSON(map[string]interface{}{"stream": "node-shell", "reason": ReasonServerGone, "pod": r.Pod, "pod_deleted": deleted})
	rec.Result, rec.Error = audit.ResultSuccess, ""
	wctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	_, _ = t.audit.Write(wctx, rec) // audit.Guarded counts a failure
}
