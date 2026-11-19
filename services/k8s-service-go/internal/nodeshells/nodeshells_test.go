package nodeshells

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// auditRows keeps the rows written.
type auditRows struct {
	mu   sync.Mutex
	rows []audit.Record
}

func (a *auditRows) Write(_ context.Context, rec audit.Record) (int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rows = append(a.rows, rec)
	return int64(len(a.rows)), nil
}

func (a *auditRows) all() []audit.Record {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]audit.Record(nil), a.rows...)
}

// clock is a test clock the stores and trackers read.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// pods stands in for the clusters: the pods that exist by row id, what was deleted, and an error to answer.
type pods struct {
	mu      sync.Mutex
	exist   map[string]bool
	deleted []string
	err     error
}

func (p *pods) remover() Remover {
	return func(_ context.Context, r Row) (bool, error) {
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.err != nil {
			return false, p.err
		}
		if !p.exist[r.ID] {
			return false, nil
		}
		delete(p.exist, r.ID)
		p.deleted = append(p.deleted, r.ID)
		return true, nil
	}
}

func (p *pods) gone() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.deleted...)
}

// server is one k8s-service process: its tracker on the shared store, the shared clock and the shared pods.
func server(c *clock, store *Memory, p *pods, w audit.Writer, name string) *Tracker {
	t := NewTracker(store, p.remover(), w)
	t.owner, t.now = name, c.now
	return t
}

// inContact gives the trackers a run of answered database calls staleAfter long ending now, as a replica that has
// been up a while has.
func inContact(trs ...*Tracker) {
	for _, tr := range trs {
		now := tr.now()
		tr.mu.Lock()
		tr.contactSince, tr.contactLast = now.Add(-tr.staleAfter), now
		tr.mu.Unlock()
	}
}

func base(node string) audit.Record {
	return audit.Record{Service: audit.ServiceK8s, Action: "k8s.session.end", ActorUserID: "u1", ActorEmail: "ops@example.com",
		TargetType: "node", TargetID: node, Cluster: "self", Namespace: "kubeast-node-shell", RequestIP: "10.0.0.9"}
}

// open stores a shell on tr whose pod then exists, as the handler does.
func open(t *testing.T, tr *Tracker, p *pods, id string) {
	t.Helper()
	if err := tr.Begin(context.Background(), Row{ID: id, Cluster: "self", Namespace: "kubeast-node-shell", Pod: "node-debugger-n1-" + id, Node: "n1"}, base("n1")); err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	p.exist[id] = true
	p.mu.Unlock()
}

func newWorld() (*clock, *Memory, *pods, *auditRows) {
	c := &clock{t: time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)}
	return c, NewMemory(c.now), &pods{exist: map[string]bool{}}, &auditRows{}
}

// A shell whose server keeps beating is never taken, however long it runs and however often another server sweeps.
func TestALiveServersShellIsNotDeleted(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b := server(c, store, p, rows, "a"), server(c, store, p, rows, "b")
	open(t, a, p, "s1")
	for i := 0; i < 20; i++ { // ten minutes
		c.add(beatEvery)
		a.beat(context.Background())
		c.add(beatEvery)
		a.beat(context.Background())
		inContact(b)
		b.sweep(context.Background())
	}
	if got := p.gone(); len(got) != 0 {
		t.Fatalf("deleted %v; a live server's shell must stay", got)
	}
	if r, ok := store.Rows()["s1"]; !ok || r.Owner != "a" {
		t.Fatalf("row = %+v %v, want it held by a", r, ok)
	}
	if len(rows.all()) != 0 {
		t.Fatalf("audit rows %v, want none", rows.all())
	}
}

// A shell whose server stopped beating (killed) has its pod deleted by another server once its row is staleAfter old,
// the row deleted and the shell's k8s.session.end row written with the opener as actor.
func TestAShellWhoseServerStoppedIsDeleted(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b := server(c, store, p, rows, "a"), server(c, store, p, rows, "b")
	open(t, a, p, "s1")

	c.add(staleAfter - time.Second)
	inContact(b)
	b.sweep(context.Background())
	if got := p.gone(); len(got) != 0 {
		t.Fatalf("deleted %v before the row was %s old", got, staleAfter)
	}

	c.add(2 * time.Second)
	inContact(b)
	b.sweep(context.Background())
	if got := p.gone(); len(got) != 1 || got[0] != "s1" {
		t.Fatalf("deleted %v, want [s1]", got)
	}
	if _, ok := store.Rows()["s1"]; ok {
		t.Fatal("the row stays after its pod was deleted")
	}
	all := rows.all()
	if len(all) != 1 {
		t.Fatalf("audit rows %d, want 1", len(all))
	}
	rec := all[0]
	var after map[string]interface{}
	_ = json.Unmarshal(rec.After, &after)
	if rec.Action != "k8s.session.end" || rec.ActorEmail != "ops@example.com" || rec.TargetID != "n1" || rec.Cluster != "self" ||
		rec.RequestIP != "10.0.0.9" || rec.Result != audit.ResultSuccess || after["reason"] != ReasonServerGone ||
		after["stream"] != "node-shell" || after["pod"] != "node-debugger-n1-s1" || after["pod_deleted"] != true {
		t.Fatalf("audit row %+v after %v", rec, after)
	}
}

// A cluster that cannot be reached leaves the row: nothing is written, the row is not taken again until it is stale
// again, and a later sweep (here on another server) deletes the pod.
func TestAClusterNotReachedLeavesTheRowToALaterSweep(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b, d := server(c, store, p, rows, "a"), server(c, store, p, rows, "b"), server(c, store, p, rows, "d")
	open(t, a, p, "s1")
	c.add(staleAfter + time.Second)

	p.err = errors.New("dial tcp: connection refused")
	inContact(b)
	b.sweep(context.Background())
	if r, ok := store.Rows()["s1"]; !ok || r.Owner != "b" {
		t.Fatalf("row = %+v %v, want it kept, taken by b", r, ok)
	}
	if len(rows.all()) != 0 {
		t.Fatalf("audit rows %v, want none while the pod is not deleted", rows.all())
	}

	p.err = nil
	c.add(sweepEvery)
	inContact(b, d)
	d.sweep(context.Background())
	if got := p.gone(); len(got) != 0 {
		t.Fatalf("deleted %v; the row was taken %s ago, not stale yet", got, sweepEvery)
	}

	c.add(staleAfter)
	inContact(d)
	d.sweep(context.Background())
	if got := p.gone(); len(got) != 1 || got[0] != "s1" {
		t.Fatalf("deleted %v, want [s1] on the later sweep", got)
	}
	if _, ok := store.Rows()["s1"]; ok {
		t.Fatal("the row stays after its pod was deleted")
	}
	if len(rows.all()) != 1 {
		t.Fatalf("audit rows %d, want 1", len(rows.all()))
	}
}

// Of two servers sweeping, one takes a row and deletes its pod; the other finds nothing.
func TestOneTakerWhenServersSweepAtOnce(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b, d := server(c, store, p, rows, "a"), server(c, store, p, rows, "b"), server(c, store, p, rows, "d")
	open(t, a, p, "s1")
	c.add(staleAfter + time.Second)
	inContact(b, d)
	b.sweep(context.Background())
	d.sweep(context.Background())
	if got := p.gone(); len(got) != 1 {
		t.Fatalf("deleted %v, want one delete", got)
	}
	if len(rows.all()) != 1 {
		t.Fatalf("audit rows %d, want 1", len(rows.all()))
	}
}

// While the database pauses every heartbeat stops; a server back in contact for less than staleAfter judges nothing,
// and the owner beats again before it may: no live shell is deleted.
func TestADatabasePauseDeletesNoLiveShell(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b := server(c, store, p, rows, "a"), server(c, store, p, rows, "b")
	open(t, a, p, "s1")
	inContact(b)

	store.Fail = errors.New("connection refused")
	for i := 0; i < 8; i++ { // two minutes paused
		c.add(beatEvery)
		a.beat(context.Background())
		if i%2 == 1 {
			b.sweep(context.Background())
		}
	}
	store.Fail = nil

	for i := 0; i < 8; i++ { // two minutes back: the sweep comes first, while the row is still two minutes old
		c.add(beatEvery)
		b.sweep(context.Background())
		a.beat(context.Background())
	}
	if got := p.gone(); len(got) != 0 {
		t.Fatalf("deleted %v after a database pause; the shell's server was beating", got)
	}
}

// A server never takes a row it tracks, even one whose beats did not reach the database.
func TestAServerDoesNotTakeItsOwnShell(t *testing.T) {
	c, store, p, rows := newWorld()
	a := server(c, store, p, rows, "a")
	open(t, a, p, "s1")
	c.add(staleAfter + time.Second)
	inContact(a)
	a.sweep(context.Background())
	if got := p.gone(); len(got) != 0 {
		t.Fatalf("deleted %v; a server's own open shell", got)
	}
}

// The owner's End deletes the row of a shell whose pod it deleted; Release leaves it for a sweep, which finds it
// stale since its owner no longer beats it.
func TestEndDeletesTheRowAndReleaseLeavesItToTheSweep(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b := server(c, store, p, rows, "a"), server(c, store, p, rows, "b")
	open(t, a, p, "s1")
	open(t, a, p, "s2")
	a.End("s1")
	if _, ok := store.Rows()["s1"]; ok {
		t.Fatal("End left the row")
	}
	a.Release("s2")
	for i := 0; i < 5; i++ {
		c.add(beatEvery)
		a.beat(context.Background())
	}
	inContact(b)
	b.sweep(context.Background())
	if got := p.gone(); len(got) != 1 || got[0] != "s2" {
		t.Fatalf("deleted %v, want [s2]", got)
	}
}

// Run sweeps from the start: a row left by a server killed before this one started is deleted once this server has
// been in contact for staleAfter.
func TestRunDeletesWhatAKilledServerLeftFromItsStart(t *testing.T) {
	store := NewMemory(nil)
	p := &pods{exist: map[string]bool{"old": true}}
	if err := store.Insert(context.Background(), Row{ID: "old", Cluster: "self", Namespace: "kubeast-node-shell", Pod: "node-debugger-n1-old", Node: "n1", Owner: "gone/12345678"}); err != nil {
		t.Fatal(err)
	}
	tr := NewTracker(store, p.remover(), &auditRows{})
	tr.beatEvery, tr.staleAfter, tr.contactGap, tr.sweepEvery = 10*time.Millisecond, 50*time.Millisecond, 40*time.Millisecond, 20*time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go tr.Run(ctx)
	deadline := time.Now().Add(3 * time.Second)
	for len(p.gone()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := p.gone(); len(got) != 1 || got[0] != "old" {
		t.Fatalf("deleted %v, want [old]", got)
	}
}

// PersonFor keeps who the opener is and what acting as them in that cluster reads, nothing of other clusters.
func TestPersonForKeepsTheClusterOnly(t *testing.T) {
	p := auth.TokenPayload{UserID: "u1", Email: "ops@example.com", Role: "admin", TokenVersion: 3, AuthTime: 10, ExpiresAt: 20,
		Perms:      auth.PermissionMatrix{"*": {"resource.node.shell"}, "self": {"resource.*"}, "other": {"x"}},
		Roles:      map[string]string{"self": "Admin", "other": "Read"},
		Namespaces: map[string][]string{"other": {"a"}}}
	var got auth.TokenPayload
	if err := json.Unmarshal(PersonFor(p, "self"), &got); err != nil {
		t.Fatal(err)
	}
	if got.Email != "ops@example.com" || got.UserID != "u1" || len(got.Perms) != 2 || got.Perms["other"] != nil ||
		got.Roles["self"] != "Admin" || len(got.Roles) != 1 || got.Namespaces != nil || got.ExpiresAt != 0 {
		t.Fatalf("kept %+v", got)
	}
	gu, gg := got.Impersonation("self")
	wu, wg := p.Impersonation("self")
	if gu != wu || len(gg) != len(wg) {
		t.Fatalf("acts as %s %v, the opener as %s %v", gu, gg, wu, wg)
	}
	if !got.HasPermissionForCluster("resource.node.shell", "self") {
		t.Fatal("the kept claims lost resource.node.shell")
	}
}
