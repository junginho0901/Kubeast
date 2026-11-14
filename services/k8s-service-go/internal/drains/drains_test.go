package drains

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
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

// clock is a test clock several stores and trackers read.
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

func base(node string) audit.Record {
	return audit.Record{Service: audit.ServiceK8s, Action: "k8s.node.drain", ActorUserID: "u1", ActorEmail: "ops@example.com",
		TargetType: "node", TargetID: node, Cluster: "self", RequestIP: "10.0.0.9", Path: "/api/v1/nodes/" + node + "/drain"}
}

func begin(t *testing.T, tr *Tracker, id, node string) context.Context {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := tr.Begin(context.Background(), Row{ID: id, Cluster: "self", Node: node, UserID: "u1", UserEmail: "ops@example.com"}, base(node), cancel); err != nil {
		t.Fatal(err)
	}
	return ctx
}

func status(t *testing.T, tr *Tracker, id string) Row {
	t.Helper()
	r, err := tr.Status(context.Background(), id)
	if err != nil || r == nil {
		t.Fatalf("status of %s: %v %v", id, r, err)
	}
	return *r
}

// A drain's outcome is a second k8s.node.drain row with the request's actor, address and cluster:
// success when every pod was evicted, failure otherwise; an unknown drain writes none.
func TestTheDrainOutcomeIsRecorded(t *testing.T) {
	rows := &auditRows{}
	tr := NewTracker(NewMemory(nil), rows)
	begin(t, tr, "d-ok", "n1")
	begin(t, tr, "d-bad", "n1")
	if !tr.Finish("d-ok", StatusSuccess, "drain completed, 3 pods evicted") ||
		!tr.Finish("d-bad", StatusError, "drain incomplete: 1 of 3 pods could not be evicted") {
		t.Fatal("finish not taken")
	}
	if tr.Finish("d-unknown", StatusSuccess, "") {
		t.Fatal("an unknown drain took an end")
	}
	got := rows.all()
	if len(got) != 2 {
		t.Fatalf("rows %d", len(got))
	}
	ok, bad := got[0], got[1]
	if ok.Action != "k8s.node.drain" || ok.Result != audit.ResultSuccess || ok.ActorUserID != "u1" || ok.Cluster != "self" ||
		ok.TargetID != "n1" || ok.RequestIP != "10.0.0.9" || !strings.Contains(string(ok.After), `"phase":"finished"`) {
		t.Fatalf("success row %+v", ok)
	}
	if bad.Result != audit.ResultFailure || !strings.Contains(bad.Error, "could not be evicted") || !strings.Contains(string(bad.After), `"status":"error"`) {
		t.Fatalf("failure row %+v", bad)
	}
}

// Two servers on one database: what the server running the drain writes, the other reads.
func TestTwoServersReadTheSameDrain(t *testing.T) {
	db := NewMemory(nil)
	a, b := NewTracker(db, nil), NewTracker(db, nil)
	begin(t, a, "d1", "n1")
	if r := status(t, b, "d1"); r.Status != StatusPending || r.Node != "n1" || r.Cluster != "self" {
		t.Fatalf("server b reads %+v", r)
	}
	total, done := 4, 1
	a.Progress("d1", Progress{Status: StatusDraining, PodsTotal: &total, PodsDone: &done})
	if r := status(t, b, "d1"); r.Status != StatusDraining || *r.PodsTotal != 4 || *r.PodsDone != 1 {
		t.Fatalf("server b reads %+v", r)
	}
	// b holds no row of its own: its writes change nothing
	b.Progress("d1", Progress{Status: StatusError})
	if b.Finish("d1", StatusError, "not mine") {
		t.Fatal("another server ended the drain")
	}
	a.Finish("d1", StatusSuccess, "drain completed, 4 pods evicted")
	if r := status(t, b, "d1"); r.Status != StatusSuccess || r.Message != "drain completed, 4 pods evicted" || r.Open() {
		t.Fatalf("server b reads %+v", r)
	}
	if r, err := b.Status(context.Background(), "nope"); r != nil || err != nil {
		t.Fatalf("an unknown drain: %v %v", r, err)
	}
}

// The server running a drain stops beating: within the stale time another server reads it as
// interrupted, writes its finished row once with the start request's actor, and the owner, back,
// stops the drain and writes no end over it.
func TestAStoppedOwnerReadsAsInterruptedWithinTheStaleTime(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 14, 21, 0, 0, 0, time.UTC)}
	db := NewMemory(c.now)
	rows := &auditRows{}
	a, b := NewTracker(db, rows), NewTracker(db, rows)
	running := begin(t, a, "d1", "n1")

	for range 6 { // a beats every 5 s: never stale
		c.add(a.beatEvery)
		a.beat(context.Background())
		if r := status(t, b, "d1"); r.Status != StatusPending {
			t.Fatalf("while a beats: %+v", r)
		}
	}
	c.add(a.staleAfter) // a stops: exactly the stale time is not past
	if r := status(t, b, "d1"); r.Status != StatusPending {
		t.Fatalf("at the stale time: %+v", r)
	}
	c.add(time.Second)
	r := status(t, b, "d1")
	if r.Status != StatusInterrupted || r.Message != MessageOwnerGone || r.Open() {
		t.Fatalf("past the stale time: %+v", r)
	}
	if again := status(t, b, "d1"); again.Status != StatusInterrupted {
		t.Fatalf("read again: %+v", again)
	}
	got := rows.all()
	if len(got) != 1 || got[0].Result != audit.ResultFailure || got[0].ActorUserID != "u1" || got[0].RequestIP != "10.0.0.9" ||
		!strings.Contains(string(got[0].After), `"status":"interrupted"`) || got[0].Error != MessageOwnerGone || got[0].Before != nil {
		t.Fatalf("finished rows %+v", got)
	}

	// a comes back: its beat no longer finds the row, so it stops the drain
	a.beat(context.Background())
	select {
	case <-running.Done():
	default:
		t.Fatal("the owner did not stop the drain another server marked")
	}
	if a.Finish("d1", StatusSuccess, "drain completed") {
		t.Fatal("the owner wrote an end over interrupted")
	}
	if r := status(t, b, "d1"); r.Status != StatusInterrupted || len(rows.all()) != 1 {
		t.Fatalf("after the owner's late end: %+v, %d rows", r, len(rows.all()))
	}
}

// The owner's drain ends after another server marked it but before the owner's next beat: the end is
// not taken and no second finished row is written.
func TestAnOwnersEndAfterAnotherServerMarkedItWritesNothing(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 14, 21, 0, 0, 0, time.UTC)}
	db := NewMemory(c.now)
	rows := &auditRows{}
	a, b := NewTracker(db, rows), NewTracker(db, rows)
	begin(t, a, "d1", "n1")
	c.add(a.staleAfter + time.Second)
	if r := status(t, b, "d1"); r.Status != StatusInterrupted {
		t.Fatalf("past the stale time: %+v", r)
	}
	if a.Finish("d1", StatusSuccess, "drain completed") {
		t.Fatal("the owner's end was taken over interrupted")
	}
	if got := rows.all(); len(got) != 1 || !strings.Contains(string(got[0].After), `"status":"interrupted"`) {
		t.Fatalf("finished rows %+v", got)
	}
}

// Many servers read a stale drain at the same moment: it is marked once, with one finished row.
func TestOneTakerWhenServersMarkAtOnce(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 14, 21, 0, 0, 0, time.UTC)}
	db := NewMemory(c.now)
	rows := &auditRows{}
	owner := NewTracker(db, rows)
	begin(t, owner, "d1", "n1")
	c.add(owner.staleAfter + time.Second)

	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range 8 {
		tr := NewTracker(db, rows)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if i%2 == 0 {
				tr.sweep(context.Background())
				return
			}
			if r, err := tr.Status(context.Background(), "d1"); err != nil || r == nil || r.Status != StatusInterrupted {
				t.Errorf("reader %d: %+v %v", i, r, err)
			}
		}()
	}
	close(start)
	wg.Wait()
	if got := rows.all(); len(got) != 1 {
		t.Fatalf("%d finished rows, want 1", len(got))
	}
}

// A server that shuts down marks its open drains at once, stops them and writes their rows; another
// server's drain is left alone.
func TestShutdownMarksThisServersDrainsAtOnce(t *testing.T) {
	db := NewMemory(nil)
	rows := &auditRows{}
	a, b := NewTracker(db, rows), NewTracker(db, rows)
	mine := begin(t, a, "d1", "n1")
	theirs := begin(t, b, "d2", "n2")
	a.Shutdown(context.Background())
	select {
	case <-mine.Done():
	default:
		t.Fatal("shutdown did not stop the drain")
	}
	if r := status(t, b, "d1"); r.Status != StatusInterrupted || r.Message != MessageOwnerShutdown {
		t.Fatalf("this server's drain after shutdown: %+v", r)
	}
	if r := status(t, a, "d2"); r.Status != StatusPending || theirs.Err() != nil {
		t.Fatalf("another server's drain: %+v", r)
	}
	if got := rows.all(); len(got) != 1 || got[0].TargetID != "n1" {
		t.Fatalf("rows %+v", got)
	}
}

// A stale drain nobody reads is marked by the sweep; finished rows go after keepFor, open ones never.
func TestTheSweepMarksUnreadDrainsAndOldRowsGo(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 14, 21, 0, 0, 0, time.UTC)}
	db := NewMemory(c.now)
	rows := &auditRows{}
	a, b := NewTracker(db, rows), NewTracker(db, rows)
	begin(t, a, "old", "n1")
	a.Finish("old", StatusSuccess, "drain completed")
	begin(t, a, "lost", "n2")
	c.add(a.staleAfter + time.Second)
	begin(t, a, "live", "n3")
	b.sweep(context.Background())
	if r := status(t, b, "lost"); r.Status != StatusInterrupted {
		t.Fatalf("the unread stale drain: %+v", r)
	}
	if r := status(t, b, "live"); r.Status != StatusPending {
		t.Fatalf("a drain beating: %+v", r)
	}

	c.add(a.keep - a.staleAfter) // "old" is past keepFor, "lost" finished later is not
	b.purge(context.Background())
	if r, _ := b.Status(context.Background(), "old"); r != nil {
		t.Fatalf("a finished row past keepFor stayed: %+v", r)
	}
	if r, _ := b.Status(context.Background(), "lost"); r == nil {
		t.Fatal("a row finished less than keepFor ago went")
	}
	c.add(a.keep)
	b.purge(context.Background())
	if r, _ := b.Status(context.Background(), "lost"); r != nil {
		t.Fatal("the interrupted row stayed past keepFor")
	}
	if r, _ := db.Get(context.Background(), "live", a.staleAfter); r == nil || !r.Open() {
		t.Fatalf("an open row was deleted or ended by the purge: %+v", r)
	}
}
