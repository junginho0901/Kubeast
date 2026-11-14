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

// goneAfterRead is the store as a request sees it when its caller goes away right after the read: the read
// answers, then the request's context ends, and a write on that context fails as pgx's would.
type goneAfterRead struct {
	*Memory
	leave context.CancelFunc
}

func (g goneAfterRead) Get(ctx context.Context, id string, staleAfter time.Duration) (*Row, error) {
	r, err := g.Memory.Get(ctx, id, staleAfter)
	g.leave()
	return r, err
}

func (g goneAfterRead) Interrupt(ctx context.Context, id string, staleAfter time.Duration, message string) ([]Row, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return g.Memory.Interrupt(ctx, id, staleAfter, message)
}

// ctxRows keeps each row with whether its context had ended when it was written.
type ctxRows struct {
	mu    sync.Mutex
	ended []bool
}

func (c *ctxRows) Write(ctx context.Context, _ audit.Record) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ended = append(c.ended, ctx.Err() != nil)
	return int64(len(c.ended)), nil
}

// The request that finds a drain stale goes away before the mark: the drain is still marked and its
// finished row written on a context the request's end did not end.
func TestAMarkFromAGoneRequestStillWritesItsRow(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)}
	db := NewMemory(c.now)
	begin(t, NewTracker(db, nil), "d1", "n1")
	c.add(staleAfter + time.Second)

	reqCtx, leave := context.WithCancel(context.Background())
	rows := &ctxRows{}
	reader := NewTracker(goneAfterRead{Memory: db, leave: leave}, rows)
	r, err := reader.Status(reqCtx, "d1")
	if err != nil || r == nil || r.Status != StatusInterrupted {
		t.Fatalf("status from a gone request: %+v %v", r, err)
	}
	if len(rows.ended) != 1 || rows.ended[0] {
		t.Fatalf("finished rows (context ended when written): %v, want one written on a live context", rows.ended)
	}
	if got, _ := db.Get(context.Background(), "d1", staleAfter); got.Status != StatusInterrupted {
		t.Fatalf("the row: %+v", got)
	}
}

// slowAudit takes a row only when its context ends.
type slowAudit struct{}

func (slowAudit) Write(ctx context.Context, _ audit.Record) (int64, error) {
	<-ctx.Done()
	return 0, ctx.Err()
}

// Shutdown marks and writes within its deadline, however slow the audit store is, so the waits after it
// keep their time before SIGKILL.
func TestShutdownKeepsToItsDeadline(t *testing.T) {
	db := NewMemory(nil)
	a := NewTracker(db, slowAudit{})
	begin(t, a, "d1", "n1")
	begin(t, a, "d2", "n2")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	began := time.Now()
	a.Shutdown(ctx)
	if took := time.Since(began); took > 2*time.Second {
		t.Fatalf("shutdown took %s with a 200ms deadline", took)
	}
	for _, id := range []string{"d1", "d2"} {
		if r, _ := db.Get(context.Background(), id, staleAfter); r.Status != StatusInterrupted {
			t.Fatalf("%s after shutdown: %+v", id, r)
		}
	}
}

// slowPurge holds every purge until the test ends and counts the beats.
type slowPurge struct {
	*Memory
	release chan struct{}
	beats   chan struct{}
}

func (s slowPurge) Purge(ctx context.Context, keep time.Duration, batch int) (int64, error) {
	select {
	case <-s.release:
	case <-ctx.Done():
	}
	return 0, nil
}

func (s slowPurge) Beat(ctx context.Context, owner string) ([]string, error) {
	select {
	case s.beats <- struct{}{}:
	default:
	}
	return s.Memory.Beat(ctx, owner)
}

// The heartbeat goes on while a purge is slow: it has a goroutine of its own.
func TestTheHeartbeatGoesOnWhileTheCleanupIsSlow(t *testing.T) {
	store := slowPurge{Memory: NewMemory(nil), release: make(chan struct{}), beats: make(chan struct{}, 1)}
	defer close(store.release)
	tr := NewTracker(store, nil)
	tr.beatEvery, tr.sweepEvery, tr.purgeEvery = 10*time.Millisecond, time.Hour, time.Hour
	begin(t, tr, "d1", "n1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go tr.Run(ctx) // its first purge is held
	for i := range 2 {
		select {
		case <-store.beats:
		case <-time.After(2 * time.Second):
			t.Fatalf("beat %d did not come while the purge was held", i+1)
		}
	}
}
