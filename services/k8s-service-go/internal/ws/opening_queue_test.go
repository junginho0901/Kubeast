package ws

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

// takeNow takes a place of q for cluster, or fails the test after a second.
func takeNow(t *testing.T, q *openingQueue, cluster string) func() {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	give, err := q.take(ctx, cluster)
	if err != nil {
		t.Fatalf("%s got no place: %v", cluster, err)
	}
	return give
}

// waitFor starts a take of a place for cluster, in line behind those already waiting, and returns a channel that gets
// its give once it has one.
func waitFor(ctx context.Context, q *openingQueue, cluster string) <-chan func() {
	got := make(chan func(), 1)
	before := q.waiters()
	go func() {
		if give, err := q.take(ctx, cluster); err == nil {
			got <- give
		}
	}()
	for deadline := time.Now().Add(time.Second); q.waiters() == before && len(got) == 0 && time.Now().Before(deadline); {
		time.Sleep(time.Millisecond)
	}
	return got
}

func gets(t *testing.T, got <-chan func(), what string) {
	t.Helper()
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s got no place", what)
	}
}

func notYet(t *testing.T, got <-chan func(), what string) {
	t.Helper()
	select {
	case <-got:
		t.Fatalf("%s got a place", what)
	case <-time.After(50 * time.Millisecond):
	}
}

// An answering cluster alone takes every place; once another cluster waits, the places given back go to it until it
// holds half of them, then to whoever waits.
func TestTheOpeningQueueLendsFreePlacesAndGivesThemBackToOthersFirst(t *testing.T) {
	q := newOpeningQueue(4)
	q.setAnswering("a", true)
	q.setAnswering("b", true)
	gives := []func(){takeNow(t, q, "a"), takeNow(t, q, "a"), takeNow(t, q, "a"), takeNow(t, q, "a")}
	ctx := testCtx(t)
	aNext := waitFor(ctx, q, "a")
	bFirst := waitFor(ctx, q, "b")
	bSecond := waitFor(ctx, q, "b")
	gives[0]()
	gets(t, bFirst, "b, under half")
	notYet(t, aNext, "a, past half, while b waited")
	gives[1]()
	gets(t, bSecond, "b's second watch")
	gives[2]()
	select {
	case <-aNext:
	case <-time.After(time.Second):
		t.Fatal("a got no place once b waited no more")
	}
	if a, b := q.heldBy("a"), q.heldBy("b"); a != 2 || b != 2 {
		t.Errorf("a holds %d and b %d, want 2 and 2", a, b)
	}
}

// A cluster that has not answered a start holds one place at a time, also alone.
func TestTheOpeningQueueGivesAClusterThatHasNotAnsweredOnePlace(t *testing.T) {
	q := newOpeningQueue(4)
	give := takeNow(t, q, "dead")
	ctx := testCtx(t)
	next := waitFor(ctx, q, "dead")
	notYet(t, next, "a second watch of a cluster that has not answered")
	other := takeNow(t, q, "ok")
	other()
	give()
	gets(t, next, "the next watch once the first gave its place back")
}

// A watch whose context ends gives its place back, or its turn in the line.
func TestTheOpeningQueueTakesBackWhatACancelledWaitHeld(t *testing.T) {
	q := newOpeningQueue(2)
	give := takeNow(t, q, "a")
	ctx, cancel := context.WithCancel(context.Background())
	waiting := waitFor(ctx, q, "a")
	if n := q.waiters(); n != 1 {
		t.Fatalf("%d waiting, want 1", n)
	}
	cancel()
	select {
	case <-waiting:
		t.Fatal("a cancelled wait got a place")
	case <-time.After(50 * time.Millisecond):
	}
	if n := q.waiters(); n != 0 {
		t.Errorf("%d still waiting after the cancel, want 0", n)
	}
	give()
	if n := q.InUse(); n != 0 {
		t.Errorf("%d places in use, want 0", n)
	}
}

// Many clusters take turns: each one waiting gets places, none is passed over.
func TestTheOpeningQueueServesEveryWaitingCluster(t *testing.T) {
	q := newOpeningQueue(2)
	var mu sync.Mutex
	served := map[string]int{}
	var wg sync.WaitGroup
	for i := 0; i < 60; i++ {
		c := fmt.Sprintf("c%d", i%6)
		q.setAnswering(c, true)
		wg.Add(1)
		go func() {
			defer wg.Done()
			give := takeNow(t, q, c)
			mu.Lock()
			served[c]++
			mu.Unlock()
			time.Sleep(time.Millisecond)
			give()
		}()
	}
	wg.Wait()
	for i := 0; i < 6; i++ {
		if n := served[fmt.Sprintf("c%d", i)]; n != 10 {
			t.Errorf("c%d was served %d times, want 10", i, n)
		}
	}
}
