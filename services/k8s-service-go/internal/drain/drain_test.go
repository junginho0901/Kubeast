package drain

import (
	"context"
	"testing"
	"time"
)

func ended(t *testing.T, ctx context.Context, within time.Duration) {
	t.Helper()
	select {
	case <-ctx.Done():
		if !Ended(ctx) {
			t.Fatalf("ended with %v, want the server leaving", context.Cause(ctx))
		}
	case <-time.After(within):
		t.Fatal("still open")
	}
}

func open(t *testing.T, ctx context.Context) {
	t.Helper()
	if ctx.Err() != nil {
		t.Fatalf("ended early: %v", context.Cause(ctx))
	}
}

func TestAFollowedLogEndsAsSoonAsTheServerStartsLeaving(t *testing.T) {
	d := New()
	logCtx, releaseLog := d.HoldStream(context.Background())
	_, releaseTerm := d.HoldTerminal(context.Background())
	done := make(chan Result)
	go func() { done <- d.Run(time.Hour, time.Second) }()
	ended(t, logCtx, time.Second)
	releaseLog()
	releaseTerm() // the terminal's person typed exit
	select {
	case res := <-done:
		if res.Streams != 1 || res.TerminalsLeft != 1 || res.TerminalsCut != 0 || res.Unreleased != 0 {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run waited although no terminal was left")
	}
}

func TestATerminalIsWarnedThenGetsTheWaitThenEnds(t *testing.T) {
	d := New()
	ctx, release := d.HoldTerminal(context.Background())
	warned, closeAt := Warning(ctx)
	select {
	case <-warned:
		t.Fatal("warned before the server started leaving")
	default:
	}
	start := time.Now()
	done := make(chan Result)
	go func() { done <- d.Run(300*time.Millisecond, time.Second) }()
	select {
	case <-warned:
	case <-time.After(time.Second):
		t.Fatal("not warned")
	}
	if at := closeAt(); at.Before(start.Add(250*time.Millisecond)) || at.After(start.Add(time.Second)) {
		t.Fatalf("closes at +%v, want about +300ms", at.Sub(start))
	}
	time.Sleep(150 * time.Millisecond)
	open(t, ctx) // still within the wait
	ended(t, ctx, time.Second)
	if waited := time.Since(start); waited < 250*time.Millisecond {
		t.Fatalf("ended after %v, before the wait was over", waited)
	}
	release()
	res := <-done
	if res.TerminalsCut != 1 || res.TerminalsLeft != 0 || res.Unreleased != 0 {
		t.Fatalf("result %+v", res)
	}
}

func TestRunReturnsAsSoonAsTheLastTerminalEnds(t *testing.T) {
	d := New()
	_, release := d.HoldTerminal(context.Background())
	done := make(chan Result)
	go func() { done <- d.Run(time.Hour, time.Second) }()
	time.Sleep(50 * time.Millisecond)
	release()
	select {
	case res := <-done:
		if res.TerminalsLeft != 1 || res.TerminalsCut != 0 {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run kept waiting with no terminal open")
	}
}

func TestWithNothingOpenRunReturnsAtOnce(t *testing.T) {
	start := time.Now()
	if res := New().Run(time.Hour, time.Hour); res != (Result{}) {
		t.Fatalf("result %+v", res)
	}
	if took := time.Since(start); took > time.Second {
		t.Fatalf("took %v", took)
	}
}

func TestATerminalThatDoesNotLetGoIsCountedAfterTheCloseWait(t *testing.T) {
	d := New()
	d.HoldTerminal(context.Background()) // never released
	res := d.Run(10*time.Millisecond, 50*time.Millisecond)
	if res.TerminalsCut != 1 || res.Unreleased != 1 {
		t.Fatalf("result %+v", res)
	}
}

func TestAConnectionThatComesWhileLeavingEndsAtOnce(t *testing.T) {
	d := New()
	_, release := d.HoldTerminal(context.Background())
	go d.Run(time.Hour, time.Second)
	for !d.Leaving() {
		time.Sleep(time.Millisecond)
	}
	late, lateRelease := d.HoldTerminal(context.Background())
	ended(t, late, time.Second)
	lateLog, lateLogRelease := d.HoldStream(context.Background())
	ended(t, lateLog, time.Second)
	lateRelease()
	lateLogRelease()
	release()
}

func TestAReleasedConnectionIsNotTheServerLeaving(t *testing.T) {
	d := New()
	ctx, release := d.HoldTerminal(context.Background())
	release()
	release() // twice is once
	if ctx.Err() == nil || Ended(ctx) {
		t.Fatalf("released: err %v, ended by the drain %v", ctx.Err(), Ended(ctx))
	}
	if terms, streams := d.Open(); terms != 0 || streams != 0 {
		t.Fatalf("open %d %d", terms, streams)
	}
}

func TestOpenCountsEachKind(t *testing.T) {
	d := New()
	_, r1 := d.HoldTerminal(context.Background())
	_, r2 := d.HoldStream(context.Background())
	_, r3 := d.HoldStream(context.Background())
	if terms, streams := d.Open(); terms != 1 || streams != 2 {
		t.Fatalf("open %d terminals %d streams", terms, streams)
	}
	r1()
	r2()
	r3()
}

func TestAParentEndingIsNotTheServerLeaving(t *testing.T) {
	d := New()
	parent, cancel := context.WithCancel(context.Background())
	ctx, release := d.HoldTerminal(parent)
	defer release()
	cancel()
	<-ctx.Done()
	if Ended(ctx) {
		t.Fatal("a closed browser read as the server leaving")
	}
}

func TestNoDrainHoldsNothingAndNeverWarns(t *testing.T) {
	var d *Drain
	ctx, release := d.HoldTerminal(context.Background())
	release()
	if ctx.Err() != nil || d.Leaving() {
		t.Fatal("a nil Drain ended something")
	}
	warned, _ := Warning(context.Background())
	if warned != nil {
		t.Fatal("a context no Drain holds has a warning")
	}
	if res := d.Run(time.Hour, time.Hour); res != (Result{}) {
		t.Fatalf("result %+v", res)
	}
}

func TestOnlyTheFirstRunDoesAnything(t *testing.T) {
	d := New()
	ctx, release := d.HoldStream(context.Background())
	defer release()
	first := make(chan Result)
	go func() { first <- d.Run(0, time.Second) }()
	ended(t, ctx, time.Second)
	release()
	<-first
	if res := d.Run(0, 0); res != (Result{}) {
		t.Fatalf("second Run %+v", res)
	}
}
