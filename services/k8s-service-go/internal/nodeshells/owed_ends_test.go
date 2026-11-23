package nodeshells

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// flakyAudit is an audit store that refuses rows while down, counts every try, and is ready only while up (Readier).
type flakyAudit struct {
	auditRows
	mu    sync.Mutex
	down  bool
	tries int
}

func (a *flakyAudit) set(down bool) { a.mu.Lock(); a.down = down; a.mu.Unlock() }

func (a *flakyAudit) Write(ctx context.Context, rec audit.Record) (int64, error) {
	a.mu.Lock()
	a.tries++
	down := a.down
	a.mu.Unlock()
	if down {
		return 0, errors.New("dial tcp: i/o timeout")
	}
	return a.auditRows.Write(ctx, rec)
}

func (a *flakyAudit) Ready(context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.down {
		return audit.ErrUnavailable
	}
	return nil
}

func (a *flakyAudit) tried() int { a.mu.Lock(); defer a.mu.Unlock(); return a.tries }

func endRow(target string) audit.Record {
	return audit.Record{Service: audit.ServiceK8s, Action: "k8s.session.end", ActorUserID: "u1", TargetType: "node", TargetID: target,
		Cluster: "c", After: audit.MustJSON(map[string]interface{}{"stream": "node-shell", "reason": ReasonHeartbeatLost,
			"ended_at": "2026-11-20T01:02:03Z"})}
}

// A heartbeat_lost row the audit store does not take is kept and written once, unchanged, when the database answers
// and the store is ready again; until then nothing is tried (no stdout copy per tick), and once written nothing more.
func TestAnEndRowTheStoreDidNotTakeIsWrittenOnceItTakesRowsAgain(t *testing.T) {
	store := NewMemory(nil)
	rows := &flakyAudit{}
	tr := NewTracker(store, nil, rows, time.Hour)
	ctx := context.Background()

	rows.set(true)
	store.SetFail(errors.New("dial tcp: i/o timeout"))
	if !tr.WriteEnd(ctx, endRow("n1")) {
		t.Fatal("a tracker with a writer did not take the row")
	}
	if tr.Owed() != 1 || len(rows.all()) != 0 || rows.tried() != 1 {
		t.Fatalf("owed %d, rows %d, tries %d: want the row kept after one try", tr.Owed(), len(rows.all()), rows.tried())
	}
	tr.payOwed(ctx) // the database does not answer: no try
	store.SetFail(nil)
	tr.payOwed(ctx) // it answers, the audit store is not ready yet: no try
	if rows.tried() != 1 || tr.Owed() != 1 {
		t.Fatalf("tries %d owed %d while the store was not ready, want 1 and 1", rows.tried(), tr.Owed())
	}

	rows.set(false)
	tr.payOwed(ctx)
	got := rows.all()
	if len(got) != 1 || tr.Owed() != 0 || string(got[0].After) != string(endRow("n1").After) || got[0].ActorUserID != "u1" {
		t.Fatalf("rows %+v owed %d: want the row written once as it was", got, tr.Owed())
	}
	tr.payOwed(ctx)
	if len(rows.all()) != 1 || rows.tried() != 2 {
		t.Fatalf("rows %d tries %d after paying, want 1 and 2", len(rows.all()), rows.tried())
	}

	if !tr.WriteEnd(ctx, endRow("n2")) || tr.Owed() != 0 || len(rows.all()) != 2 {
		t.Fatalf("a row the store takes at once: owed %d rows %d", tr.Owed(), len(rows.all()))
	}
}

// Owed rows are written oldest first and stop at the first one not taken; past maxOwedEnds the oldest is given up.
func TestOwedEndRowsKeepTheirOrderAndABound(t *testing.T) {
	store := NewMemory(nil)
	rows := &flakyAudit{}
	tr := NewTracker(store, nil, rows, time.Hour)
	ctx := context.Background()
	rows.set(true)
	for i := range maxOwedEnds + 3 {
		tr.WriteEnd(ctx, endRow(fmt.Sprintf("n%d", i)))
	}
	if tr.Owed() != maxOwedEnds {
		t.Fatalf("owed %d, want the bound %d", tr.Owed(), maxOwedEnds)
	}
	rows.set(false)
	tr.payOwed(ctx)
	got := rows.all()
	if len(got) != maxOwedEnds || got[0].TargetID != "n3" || got[len(got)-1].TargetID != fmt.Sprintf("n%d", maxOwedEnds+2) {
		t.Fatalf("written %d, first %s last %s: want n3 .. n%d in order", len(got), got[0].TargetID, got[len(got)-1].TargetID, maxOwedEnds+2)
	}
}

// slowAudit takes every row, each after takes on the test clock: an audit store back after an outage, slow but
// answering within opTimeout.
type slowAudit struct {
	auditRows
	c     *clock
	takes time.Duration
}

func (a *slowAudit) Write(ctx context.Context, rec audit.Record) (int64, error) {
	a.c.add(a.takes)
	return a.auditRows.Write(ctx, rec)
}

// Sixteen owed rows the audit store takes in 4 s each do not hold back the heartbeat of a shell opened once the
// database was back. Each tick runs as beatLoop runs it (beat, then payOwed; a tick the ticker gave while the last one
// ran comes at once) and another server, in contact all along, sweeps right before the next beat: the beats stay
// beatEvery apart, the other server takes no row and deletes no pod, the owner closes nothing, and every owed row is
// written once, oldest first.
func TestSlowOwedRowsDoNotHoldTheHeartbeatBack(t *testing.T) {
	c, store, p, _ := newWorld()
	rows := &slowAudit{c: c, takes: 4 * time.Second}
	other := &auditRows{}
	a, b := server(c, store, p, rows, "a"), server(c, store, p, other, "b")
	ctx := context.Background()
	const rowsOwed = 16
	for i := range rowsOwed {
		a.owedSeq++
		a.owed = append(a.owed, owedEnd{seq: a.owedSeq, rec: endRow(fmt.Sprintf("n%d", i))})
	}
	closed := false
	open(t, a, p, "s1", func() { closed = true })

	savedAt := func() time.Time { a.mu.Lock(); defer a.mu.Unlock(); return a.savedAt }
	lastSaved, next := savedAt(), c.now().Add(beatEvery)
	for tick := 0; ; tick++ {
		if tick > rowsOwed {
			t.Fatalf("%d rows still owed after %d ticks", a.Owed(), tick)
		}
		if now := c.now(); now.Before(next) {
			c.add(next.Sub(now))
		}
		tickAt := c.now()
		a.beat(ctx)
		if gap := savedAt().Sub(lastSaved); gap > beatEvery {
			t.Fatalf("tick %d: beat saved %s after the one before, want at most %s", tick, gap, beatEvery)
		}
		lastSaved = savedAt()
		if a.Owed() == 0 {
			break
		}
		a.payOwed(ctx)
		inContact(b)
		b.sweep(ctx)
		if got := p.gone(); len(got) != 0 {
			t.Fatalf("tick %d: the other server deleted %v while its server was writing owed rows", tick, got)
		}
		if took := c.now().Sub(tickAt); took > beatEvery {
			t.Fatalf("tick %d took %s, want at most %s", tick, took, beatEvery)
		}
		next = tickAt.Add(beatEvery)
	}
	if r, ok := store.Rows()["s1"]; !ok || r.Owner != "a" || closed || !p.has("s1") {
		t.Fatalf("row %+v kept %v, closed %v, pod %v: want the live shell left with its server", r, ok, closed, p.has("s1"))
	}
	got := rows.all()
	if len(got) != rowsOwed {
		t.Fatalf("written %d rows, want %d", len(got), rowsOwed)
	}
	for i, r := range got {
		if want := fmt.Sprintf("n%d", i); r.TargetID != want {
			t.Fatalf("row %d is %s, want %s: oldest first, each once", i, r.TargetID, want)
		}
	}
	if len(other.all()) != 0 {
		t.Fatalf("the other server wrote %v", other.reasons())
	}
}

// Run pays what is owed at a beat tick once the store is back, and tries once more as it ends.
func TestRunWritesTheOwedRowsAtABeatAndAsItEnds(t *testing.T) {
	store := NewMemory(nil)
	rows := &flakyAudit{}
	tr := NewTracker(store, nil, rows, time.Hour).WithTimes(10*time.Millisecond, time.Hour, time.Hour)
	ctx := context.Background()
	rows.set(true)
	tr.WriteEnd(ctx, endRow("n1"))
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); tr.Run(runCtx) }()
	rows.set(false)
	deadline := time.Now().Add(3 * time.Second)
	for tr.Owed() != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if tr.Owed() != 0 || len(rows.all()) != 1 {
		t.Fatalf("owed %d rows %d: want the row written at a beat", tr.Owed(), len(rows.all()))
	}
	stop()
	<-done

	// no beat comes before the stop: the last try writes it
	last := NewTracker(store, nil, rows, time.Hour).WithTimes(time.Hour, 2*time.Hour, time.Hour)
	rows.set(true)
	last.WriteEnd(ctx, endRow("n2"))
	runCtx, stop = context.WithCancel(ctx)
	done = make(chan struct{})
	go func() { defer close(done); last.Run(runCtx) }()
	rows.set(false)
	stop()
	<-done
	if last.Owed() != 0 || len(rows.all()) != 2 {
		t.Fatalf("owed %d rows %d after Run ended, want the second written by the last try", last.Owed(), len(rows.all()))
	}
}

// A tracker without an audit writer takes nothing, so the caller writes the row itself.
func TestWriteEndWithoutAWriterSaysSo(t *testing.T) {
	tr := NewTracker(NewMemory(nil), nil, nil, time.Hour)
	if tr.WriteEnd(context.Background(), endRow("n1")) || tr.Owed() != 0 {
		t.Fatal("a tracker without a writer kept a row")
	}
}
