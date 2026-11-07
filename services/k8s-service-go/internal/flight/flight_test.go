package flight

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// waitUntil polls cond for a moment; a test that needs an order waits for it instead of sleeping a guess.
func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("never happened: %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func (g *Group[T]) waitersOnNext(key string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	st := g.keys[key]
	if st == nil || st.next == nil {
		return 0
	}
	return st.next.waiters
}

// A crowd arriving while one read runs costs one read more, whose answer they all get.
func TestACrowdOnOneKeyCostsAtMostTwoReads(t *testing.T) {
	var g Group[int]
	var reads atomic.Int64
	release := make(chan struct{})
	read := func(context.Context) (int, error) {
		n := reads.Add(1)
		<-release
		return int(n), nil
	}
	var wg sync.WaitGroup
	results := make([]int, 40)
	wg.Add(1)
	go func() {
		defer wg.Done()
		results[0], _, _ = g.Do(context.Background(), "k", read)
	}()
	waitUntil(t, "the first read started", func() bool { return reads.Load() == 1 })
	for i := 1; i < len(results); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], _, _ = g.Do(context.Background(), "k", read)
		}()
	}
	waitUntil(t, "the crowd waits on the next read", func() bool { return g.waitersOnNext("k") == 39 })
	close(release)
	wg.Wait()
	if reads.Load() != 2 {
		t.Errorf("%d reads for 40 callers, want 2", reads.Load())
	}
	if results[0] != 1 {
		t.Errorf("the first caller got read %d", results[0])
	}
	for i := 1; i < len(results); i++ {
		if results[i] != 2 {
			t.Errorf("caller %d got read %d, which started before it asked", i, results[i])
		}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.keys) != 0 {
		t.Errorf("%d keys left after the reads ended", len(g.keys))
	}
}

// No caller gets an answer read before it asked: what it wants to see may have happened after that read started.
func TestAnAnswerIsNeverOlderThanTheQuestion(t *testing.T) {
	var g Group[int]
	var world atomic.Int64 // what the cluster holds
	world.Store(1)
	started := make(chan struct{})
	release := make(chan struct{})
	var first sync.Once
	read := func(context.Context) (int, error) {
		v := int(world.Load())
		first.Do(func() {
			close(started)
			<-release
		})
		return v, nil
	}
	firstAnswer := make(chan int, 1)
	go func() {
		v, _, _ := g.Do(context.Background(), "k", read)
		firstAnswer <- v
	}()
	<-started
	world.Store(2) // written after the first read looked
	secondAnswer := make(chan int, 1)
	go func() {
		v, _, _ := g.Do(context.Background(), "k", read)
		secondAnswer <- v
	}()
	time.Sleep(30 * time.Millisecond) // the second caller has come
	close(release)
	if v := <-firstAnswer; v != 1 {
		t.Errorf("first caller read %d", v)
	}
	if v := <-secondAnswer; v != 2 {
		t.Errorf("a caller who asked after the write read %d, want 2", v)
	}
}

// One caller going away fails nobody else: the one whose context the read started on, and the one who made the next.
func TestACallerLeavingFailsNoOneElse(t *testing.T) {
	var g Group[string]
	var reads atomic.Int64
	release := make(chan struct{})
	read := func(ctx context.Context) (string, error) {
		reads.Add(1)
		select {
		case <-release:
			return "answer", nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	firstCtx, leaveFirst := context.WithCancel(context.Background())
	defer leaveFirst()
	firstErr := make(chan error, 1)
	go func() {
		_, _, err := g.Do(firstCtx, "k", read)
		firstErr <- err
	}()
	waitUntil(t, "the first read started", func() bool { return reads.Load() == 1 })

	nextCtx, leaveNext := context.WithCancel(context.Background())
	defer leaveNext()
	nextErr := make(chan error, 1)
	go func() {
		_, _, err := g.Do(nextCtx, "k", read)
		nextErr <- err
	}()
	waitUntil(t, "the next read has its first caller", func() bool { return g.waitersOnNext("k") == 1 })

	type result struct {
		v      string
		joined bool
		err    error
	}
	stayed := make(chan result, 1)
	go func() {
		v, joined, err := g.Do(context.Background(), "k", read)
		stayed <- result{v, joined, err}
	}()
	waitUntil(t, "another caller joined it", func() bool { return g.waitersOnNext("k") == 2 })

	leaveNext()
	if err := <-nextErr; !errors.Is(err, context.Canceled) {
		t.Fatalf("the caller who left got %v", err)
	}
	leaveFirst()
	if err := <-firstErr; !errors.Is(err, context.Canceled) {
		t.Fatalf("the first caller who left got %v", err)
	}
	waitUntil(t, "the next read started", func() bool { return reads.Load() == 2 })
	close(release)
	r := <-stayed
	if r.err != nil || r.v != "answer" || !r.joined {
		t.Fatalf("the caller who stayed got %+v", r)
	}
}

// A read everyone has left stops, and a read no one still waits for never starts.
func TestAReadNoOneWaitsForStops(t *testing.T) {
	var g Group[int]
	stopped := make(chan struct{})
	ctx, leave := context.WithCancel(context.Background())
	var started atomic.Int64
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, _ = g.Do(ctx, "k", func(ctx context.Context) (int, error) {
			started.Add(1)
			<-ctx.Done()
			close(stopped)
			return 0, ctx.Err()
		})
	}()
	waitUntil(t, "the read started", func() bool { return started.Load() == 1 })

	nextCtx, leaveNext := context.WithCancel(context.Background())
	nextDone := make(chan struct{})
	go func() {
		defer close(nextDone)
		_, _, _ = g.Do(nextCtx, "k", func(context.Context) (int, error) {
			t.Error("a read no one waits for started")
			return 0, nil
		})
	}()
	waitUntil(t, "the next read was made", func() bool { return g.waitersOnNext("k") == 1 })
	leaveNext()
	<-nextDone

	leave()
	<-done
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("the read went on with no one waiting")
	}
	waitUntil(t, "the key went away", func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		return len(g.keys) == 0
	})
}

// The read runs on the first asker's values: who is asking is what it reads as.
func TestAReadCarriesTheValuesOfWhoAsked(t *testing.T) {
	type key struct{}
	var g Group[string]
	ctx := context.WithValue(context.Background(), key{}, "alice")
	v, _, err := g.Do(ctx, "k", func(ctx context.Context) (string, error) {
		s, _ := ctx.Value(key{}).(string)
		return s, nil
	})
	if err != nil || v != "alice" {
		t.Fatalf("read as %q, %v", v, err)
	}
}

func TestKeysDoNotShareAReadOrAnAnswer(t *testing.T) {
	var g Group[string]
	var wg sync.WaitGroup
	for _, k := range []string{"a", "b", "c"} {
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				v, _, err := g.Do(context.Background(), k, func(context.Context) (string, error) {
					time.Sleep(time.Millisecond)
					return k, nil
				})
				if err != nil || v != k {
					t.Errorf("key %s got %q, %v", k, v, err)
				}
			}()
		}
	}
	wg.Wait()
}

// An error is the answer of that read, for everyone waiting on it; the next read tries again.
func TestAnErrorIsTheAnswerOfThatReadOnly(t *testing.T) {
	var g Group[int]
	boom := errors.New("boom")
	if _, _, err := g.Do(context.Background(), "k", func(context.Context) (int, error) { return 0, boom }); !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
	v, _, err := g.Do(context.Background(), "k", func(context.Context) (int, error) { return 7, nil })
	if err != nil || v != 7 {
		t.Fatalf("after an error: %d, %v", v, err)
	}
}

// A panic in a read others wait on is an error for them, not the end of the process, and the key stays usable.
func TestAPanicInASharedReadIsAnError(t *testing.T) {
	var g Group[int]
	var started atomic.Int64
	release := make(chan struct{})
	first := make(chan struct{})
	go func() {
		defer close(first)
		_, _, _ = g.Do(context.Background(), "k", func(context.Context) (int, error) {
			started.Add(1)
			<-release
			return 0, nil
		})
	}()
	waitUntil(t, "the first read started", func() bool { return started.Load() == 1 })
	failed := make(chan error, 1)
	go func() {
		_, _, err := g.Do(context.Background(), "k", func(context.Context) (int, error) { panic("fixture") })
		failed <- err
	}()
	waitUntil(t, "the next read has its caller", func() bool { return g.waitersOnNext("k") == 1 })
	close(release)
	<-first
	if err := <-failed; !errors.Is(err, ErrPanicked) {
		t.Fatalf("a panic gave %v", err)
	}
	waitUntil(t, "the key went away", func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		return len(g.keys) == 0
	})
	v, _, err := g.Do(context.Background(), "k", func(context.Context) (int, error) { return 1, nil })
	if err != nil || v != 1 {
		t.Fatalf("after a panic: %d, %v", v, err)
	}
}

// A panic in a caller's own read is that caller's, for the recovery above it, and leaves the key usable.
func TestAPanicInACallersOwnReadStaysItsOwn(t *testing.T) {
	var g Group[int]
	func() {
		defer func() {
			if recover() == nil {
				t.Error("the panic did not reach the caller")
			}
		}()
		_, _, _ = g.Do(context.Background(), "k", func(context.Context) (int, error) { panic("fixture") })
	}()
	v, _, err := g.Do(context.Background(), "k", func(context.Context) (int, error) { return 1, nil })
	if err != nil || v != 1 {
		t.Fatalf("after a panic: %d, %v", v, err)
	}
}

// With no read under way a caller reads for itself; only those who wait get the read made to be shared.
func TestACallerWithNoReadToWaitForReadsForItself(t *testing.T) {
	var g Group[string]
	var started atomic.Int64
	release := make(chan struct{})
	first := make(chan string, 1)
	go func() {
		v, _, _ := g.DoOr(context.Background(), "k", func() (string, error) {
			started.Add(1)
			<-release
			return "alone", nil
		}, func(context.Context) (string, error) { return "shared", nil })
		first <- v
	}()
	waitUntil(t, "the first read started", func() bool { return started.Load() == 1 })
	second := make(chan string, 1)
	go func() {
		v, _, _ := g.DoOr(context.Background(), "k", func() (string, error) { return "alone", nil }, func(context.Context) (string, error) { return "shared", nil })
		second <- v
	}()
	waitUntil(t, "the second caller waits", func() bool { return g.waitersOnNext("k") == 1 })
	close(release)
	if v := <-first; v != "alone" {
		t.Errorf("the first caller got %q", v)
	}
	if v := <-second; v != "shared" {
		t.Errorf("the second caller got %q", v)
	}
}
