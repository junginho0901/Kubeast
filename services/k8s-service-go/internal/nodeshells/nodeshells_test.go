package nodeshells

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
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

func (a *auditRows) reasons() []string {
	var out []string
	for _, r := range a.all() {
		var after map[string]interface{}
		_ = json.Unmarshal(r.After, &after)
		s, _ := after["reason"].(string)
		out = append(out, s)
	}
	return out
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

// pods stands in for the clusters: the pods that exist by row id, what was deleted, an error to answer and a time
// each delete takes on the test clock.
type pods struct {
	mu      sync.Mutex
	exist   map[string]bool
	deleted []string
	err     error
	c       *clock
	takes   time.Duration
}

func (p *pods) remover() Remover {
	return func(_ context.Context, r Row) (bool, error) {
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.c != nil {
			p.c.add(p.takes)
		}
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

func (p *pods) has(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exist[id]
}

// cutOff is a server's own way to the database, which the test can cut while the other servers still reach it.
type cutOff struct {
	Store
	cut atomic.Bool
}

var errCut = errors.New("dial tcp: i/o timeout")

func (s *cutOff) Insert(ctx context.Context, r Row) error {
	if s.cut.Load() {
		return errCut
	}
	return s.Store.Insert(ctx, r)
}
func (s *cutOff) Beat(ctx context.Context, owner string, ids []string) ([]string, error) {
	if s.cut.Load() {
		return nil, errCut
	}
	return s.Store.Beat(ctx, owner, ids)
}
func (s *cutOff) Take(ctx context.Context, owner string, stale, expire time.Duration, skip []string, limit int) ([]Row, error) {
	if s.cut.Load() {
		return nil, errCut
	}
	return s.Store.Take(ctx, owner, stale, expire, skip, limit)
}
func (s *cutOff) Claim(ctx context.Context, id, owner string) (bool, error) {
	if s.cut.Load() {
		return false, errCut
	}
	return s.Store.Claim(ctx, id, owner)
}
func (s *cutOff) Release(ctx context.Context, id, owner string) error {
	if s.cut.Load() {
		return errCut
	}
	return s.Store.Release(ctx, id, owner)
}
func (s *cutOff) Remove(ctx context.Context, id, owner string) (bool, error) {
	if s.cut.Load() {
		return false, errCut
	}
	return s.Store.Remove(ctx, id, owner)
}
func (s *cutOff) Ping(ctx context.Context) error {
	if s.cut.Load() {
		return errCut
	}
	return s.Store.Ping(ctx)
}

const shellTimeout = time.Hour

// server is one k8s-service process: its tracker on the given store, the shared clock and the shared pods.
func server(c *clock, store Store, p *pods, w audit.Writer, name string) *Tracker {
	t := NewTracker(store, p.remover(), w, shellTimeout)
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

// open stores a shell on tr whose pod then exists, as the handler does; stop is what the handler's stop does.
func open(t *testing.T, tr *Tracker, p *pods, id string, stop func()) {
	t.Helper()
	if err := tr.Begin(context.Background(), Row{ID: id, Cluster: "self", Namespace: "kubeast-node-shell", Pod: "node-debugger-n1-" + id, Node: "n1"}, base("n1"), stop); err != nil {
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
	open(t, a, p, "s1", nil)
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
// the row deleted and the shell's k8s.session.end row written with the opener as actor, the server gone and the one
// that cleaned.
func TestAShellWhoseServerStoppedIsDeleted(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b := server(c, store, p, rows, "a"), server(c, store, p, rows, "b")
	open(t, a, p, "s1", nil)

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
		after["stream"] != "node-shell" || after["pod"] != "node-debugger-n1-s1" || after["pod_deleted"] != true ||
		after["previous_owner"] != "a" || after["cleaned_by"] != "b" {
		t.Fatalf("audit row %+v after %v", rec, after)
	}
}

// A cluster that cannot be reached leaves the row: nothing is written, the row is not taken again until it is stale
// again, and a later sweep (here on another server) deletes the pod.
func TestAClusterNotReachedLeavesTheRowToALaterSweep(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b, d := server(c, store, p, rows, "a"), server(c, store, p, rows, "b"), server(c, store, p, rows, "d")
	open(t, a, p, "s1", nil)
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
	open(t, a, p, "s1", nil)
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

// Rows taken together from a server with many shells, against a cluster that answers slowly: a second server sweeping
// while the first works on them takes none of those it still holds, the first stops within its time and leaves the
// rest to a later sweep, and every pod is deleted once with one row each.
func TestRowsTakenTogetherAreCleanedOnceWhenTheClusterIsSlow(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b, d := server(c, store, p, rows, "a"), server(c, store, p, rows, "b"), server(c, store, p, rows, "d")
	ids := []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"}
	for _, id := range ids {
		open(t, a, p, id, nil)
	}
	c.add(staleAfter + time.Second)
	p.c, p.takes = c, 9*time.Second // each delete takes 9 s
	inContact(b, d)
	b.sweep(context.Background()) // takes five, works for 30 s at most
	if n := len(p.gone()); n != 4 {
		t.Fatalf("the first sweep deleted %d pods, want 4: at 9 s each it starts no row after 30 s of work", n)
	}
	inContact(d)
	d.sweep(context.Background()) // b's rows are claimed or freshly taken: d takes the other five
	for i := 0; i < 8; i++ {
		c.add(sweepEvery)
		inContact(b, d)
		b.sweep(context.Background())
		d.sweep(context.Background())
	}
	seen := map[string]int{}
	for _, id := range p.gone() {
		seen[id]++
	}
	for _, id := range ids {
		if seen[id] != 1 {
			t.Fatalf("pod %s deleted %d times (all: %v)", id, seen[id], p.gone())
		}
	}
	if n := len(rows.all()); n != len(ids) {
		t.Fatalf("audit rows %d, want %d", n, len(ids))
	}
	if left := store.Rows(); len(left) != 0 {
		t.Fatalf("rows left %v", left)
	}
}

// A server held up past staleAfter after its take (a long pause) finds the row taken by another server when it comes
// to it, and leaves it: the pod is deleted once, by the server that holds the row, with its one end row.
func TestARowTakenByAnotherServerMeanwhileIsLeftToIt(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b, d := server(c, store, p, rows, "a"), server(c, store, p, rows, "b"), server(c, store, p, rows, "d")
	open(t, a, p, "s1", nil)
	c.add(staleAfter + time.Second)
	byB, err := store.Take(context.Background(), "b", staleAfter, b.expireAfter, nil, takeBatch)
	if err != nil || len(byB) != 1 {
		t.Fatalf("b's take = %v %v", byB, err)
	}
	c.add(staleAfter + time.Second) // b is held up
	byD, err := store.Take(context.Background(), "d", staleAfter, d.expireAfter, nil, takeBatch)
	if err != nil || len(byD) != 1 {
		t.Fatalf("d's take = %v %v", byD, err)
	}
	b.clean(context.Background(), byB[0]) // b comes to the row it took
	d.clean(context.Background(), byD[0])
	if got := p.gone(); len(got) != 1 || got[0] != "s1" {
		t.Fatalf("deleted %v, want [s1] once", got)
	}
	all := rows.all()
	if len(all) != 1 {
		t.Fatalf("audit rows %d, want 1", len(all))
	}
	var after map[string]interface{}
	_ = json.Unmarshal(all[0].After, &after)
	if after["cleaned_by"] != "d" || after["reason"] != ReasonServerGone {
		t.Fatalf("end row after %v, want server_gone cleaned by d", after)
	}
}

// A server cut off from the database while the others reach it closes its own shell before any of them may take the
// row: the stop comes when no beat has been saved for selfStopAfter, the other server's first take only after
// staleAfter, and it then finds no pod to delete and writes no end row.
func TestAServerCutOffClosesItsShellsBeforeAnotherTakesThem(t *testing.T) {
	c, mem, p, rows := newWorld()
	own := &cutOff{Store: mem}
	a, b := server(c, own, p, rows, "a"), server(c, mem, p, rows, "b")
	var stoppedAt time.Time
	open(t, a, p, "s1", func() {
		stoppedAt = c.now()
		p.mu.Lock()
		delete(p.exist, "s1") // the handler deletes its pod (the cluster answers)
		p.mu.Unlock()
		a.End("s1") // its row cannot be deleted: a is cut off
	})
	start := c.now()
	own.cut.Store(true)
	var takenAt time.Time
	for i := 0; i < 12; i++ { // three minutes in 15 s steps
		c.add(beatEvery)
		a.beat(context.Background())
		if i%2 == 1 {
			inContact(b)
			before := len(mem.Rows())
			b.sweep(context.Background())
			if takenAt.IsZero() && len(mem.Rows()) < before {
				takenAt = c.now()
			}
		}
	}
	if stoppedAt.IsZero() {
		t.Fatal("the cut-off server did not close its shell")
	}
	if got := stoppedAt.Sub(start); got < selfStopAfter || got >= staleAfter {
		t.Fatalf("closed %s after the last saved beat, want from %s and before %s", got, selfStopAfter, staleAfter)
	}
	if takenAt.IsZero() || !takenAt.After(stoppedAt) {
		t.Fatalf("the other server took the row at %v, the owner closed at %v", takenAt, stoppedAt)
	}
	if got := p.gone(); len(got) != 0 {
		t.Fatalf("the other server deleted %v; the owner had deleted it", got)
	}
	if len(rows.all()) != 0 {
		t.Fatalf("audit rows %v; the server was not gone", rows.reasons())
	}
}

// A beat that fails for less than selfStopAfter (a database restart of 30 s) closes nothing.
func TestABriefDatabaseBreakClosesNoShell(t *testing.T) {
	c, mem, p, rows := newWorld()
	own := &cutOff{Store: mem}
	a := server(c, own, p, rows, "a")
	stopped := false
	open(t, a, p, "s1", func() { stopped = true })
	own.cut.Store(true)
	c.add(beatEvery)
	a.beat(context.Background())
	c.add(beatEvery)
	a.beat(context.Background())
	own.cut.Store(false)
	c.add(beatEvery)
	a.beat(context.Background())
	c.add(beatEvery)
	a.beat(context.Background())
	if stopped {
		t.Fatal("a 30 s break closed the shell")
	}
}

// While the database pauses every heartbeat stops; a server back in contact for less than staleAfter judges nothing,
// and the owner beats again before it may: no live shell is deleted.
func TestADatabasePauseDeletesNoLiveShell(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b := server(c, store, p, rows, "a"), server(c, store, p, rows, "b")
	a.selfStopAfter = time.Hour // the pause outlasts the owner's own stop: what is held here is the others' rule
	open(t, a, p, "s1", nil)
	inContact(b)

	store.SetFail(errors.New("connection refused"))
	for i := 0; i < 8; i++ { // two minutes paused
		c.add(beatEvery)
		a.beat(context.Background())
		if i%2 == 1 {
			b.sweep(context.Background())
		}
	}
	store.SetFail(nil)

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
	a.selfStopAfter = time.Hour
	open(t, a, p, "s1", nil)
	c.add(staleAfter + time.Second)
	inContact(a)
	a.sweep(context.Background())
	if got := p.gone(); len(got) != 0 {
		t.Fatalf("deleted %v; a server's own open shell", got)
	}
}

// The owner's End deletes the row of a shell whose pod it deleted. Release marks the row given up: a sweep deletes the
// pod and writes no end row, since the shell ended on a live server.
func TestEndDeletesTheRowAndReleaseLeavesItToTheSweep(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b := server(c, store, p, rows, "a"), server(c, store, p, rows, "b")
	open(t, a, p, "s1", nil)
	open(t, a, p, "s2", nil)
	a.End("s1")
	if _, ok := store.Rows()["s1"]; ok {
		t.Fatal("End left the row")
	}
	a.Release("s2")
	if r := store.Rows()["s2"]; !r.Released {
		t.Fatalf("row %+v not marked released", r)
	}
	for i := 0; i < 5; i++ {
		c.add(beatEvery)
		a.beat(context.Background())
	}
	inContact(b)
	b.sweep(context.Background())
	if got := p.gone(); len(got) != 1 || got[0] != "s2" {
		t.Fatalf("deleted %v, want [s2]", got)
	}
	if len(rows.all()) != 0 {
		t.Fatalf("audit rows %v for a released shell", rows.reasons())
	}
}

// A row whose pod is already gone (its owner deleted it and could not delete the row) is dropped with no end row.
func TestARowWhosePodIsGoneIsDroppedWithNoEndRow(t *testing.T) {
	c, mem, p, rows := newWorld()
	own := &cutOff{Store: mem}
	a, b := server(c, own, p, rows, "a"), server(c, mem, p, rows, "b")
	open(t, a, p, "s1", nil)
	p.mu.Lock()
	delete(p.exist, "s1")
	p.mu.Unlock()
	own.cut.Store(true)
	a.End("s1") // the delete of the row fails
	c.add(staleAfter + time.Second)
	inContact(b)
	b.sweep(context.Background())
	if _, ok := mem.Rows()["s1"]; ok {
		t.Fatal("the row stays")
	}
	if len(rows.all()) != 0 {
		t.Fatalf("audit rows %v for a shell whose pod was gone", rows.reasons())
	}
}

// A row the sweep could not delete after deleting its pod gets its end row from no one twice: the next sweep finds no
// pod and writes nothing.
func TestARowNotDeletedAfterItsPodWritesNoSecondEndRow(t *testing.T) {
	c, mem, p, rows := newWorld()
	sweeper := &cutOff{Store: mem}
	a, b := server(c, mem, p, rows, "a"), server(c, sweeper, p, rows, "b")
	open(t, a, p, "s1", nil)
	c.add(staleAfter + time.Second)
	inContact(b)
	// b's Remove fails after the pod is deleted
	p.mu.Lock()
	p.c, p.takes = nil, 0
	p.mu.Unlock()
	failRemove := &removeFails{cutOff: sweeper}
	b.store = failRemove
	b.sweep(context.Background())
	if got := p.gone(); len(got) != 1 {
		t.Fatalf("deleted %v", got)
	}
	if len(rows.all()) != 0 {
		t.Fatalf("audit rows %v before the row was deleted", rows.reasons())
	}
	b.store = sweeper
	c.add(staleAfter + time.Second)
	inContact(b)
	b.sweep(context.Background())
	if _, ok := mem.Rows()["s1"]; ok {
		t.Fatal("the row stays")
	}
	if len(rows.all()) != 0 {
		t.Fatalf("audit rows %v, want none (the pod was gone at the second sweep)", rows.reasons())
	}
}

type removeFails struct{ *cutOff }

func (r *removeFails) Remove(context.Context, string, string) (bool, error) { return false, errCut }

// A row past the shell's deadline and its slack is dropped even when its pod cannot be deleted (the person's binding
// removed): the pod has ended, the row and its personal data go, and its end row says deadline_passed.
func TestARowPastTheDeadlineIsDroppedWhateverTheDelete(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b := server(c, store, p, rows, "a"), server(c, store, p, rows, "b")
	open(t, a, p, "s1", nil)
	p.err = errors.New(`pods "node-debugger-n1-s1" is forbidden`)
	c.add(staleAfter + time.Second)
	for i := 0; i < 3; i++ {
		inContact(b)
		b.sweep(context.Background())
		c.add(staleAfter + time.Second)
	}
	if _, ok := store.Rows()["s1"]; !ok {
		t.Fatal("the row went before the deadline")
	}
	c.add(shellTimeout + expireSlack)
	inContact(b)
	b.sweep(context.Background())
	if _, ok := store.Rows()["s1"]; ok {
		t.Fatal("the row stays past the deadline")
	}
	if got := rows.reasons(); len(got) != 1 || got[0] != ReasonDeadlinePassed {
		t.Fatalf("end rows %v, want [deadline_passed]", got)
	}
}

// A row past the deadline whose pod is already gone is dropped with no end row, as any row whose pod was gone.
func TestAnExpiredRowWhosePodIsGoneWritesNoEndRow(t *testing.T) {
	c, store, p, rows := newWorld()
	a, b := server(c, store, p, rows, "a"), server(c, store, p, rows, "b")
	open(t, a, p, "s1", nil)
	p.mu.Lock()
	delete(p.exist, "s1")
	p.mu.Unlock()
	a.Release("s1")
	store.mu.Lock()
	store.rows["s1"].Released = false // as if the release had not reached the database
	store.mu.Unlock()
	c.add(shellTimeout + expireSlack + time.Minute)
	inContact(b)
	b.sweep(context.Background())
	if _, ok := store.Rows()["s1"]; ok {
		t.Fatal("the row stays past the deadline")
	}
	if len(rows.all()) != 0 {
		t.Fatalf("end rows %v for an expired row whose pod was gone", rows.reasons())
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
	tr := NewTracker(store, p.remover(), &auditRows{}, shellTimeout)
	tr.beatEvery, tr.staleAfter, tr.contactGap, tr.sweepEvery, tr.workFor = 10*time.Millisecond, 50*time.Millisecond, 40*time.Millisecond, 20*time.Millisecond, 25*time.Millisecond
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
