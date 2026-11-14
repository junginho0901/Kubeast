package cache

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

// downRedis is a Redis stand-in that is not answering yet, and a cache set up for its address (read before it
// stopped: a stopped stand-in has none). Restart brings it up on the same address.
func downRedis(t *testing.T) (*miniredis.Miniredis, *Cache) {
	t.Helper()
	mr := miniredis.NewMiniRedis()
	if err := mr.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mr.Close)
	host := mr.Host()
	port, err := strconv.Atoi(mr.Port())
	if err != nil {
		t.Fatal(err)
	}
	mr.Close()
	return mr, New(host, port, 0, "")
}

func reconnect(t *testing.T, c *Cache) <-chan struct{} {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.Reconnect(ctx, 10*time.Millisecond); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return done
}

func within(t *testing.T, d time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("not within %v", d)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A cache whose Redis did not answer at start moves there once it answers: what it kept in memory goes, what it sets
// after goes to Redis, which every replica reads. A change it took meanwhile (FlushAll on its map) left the cache in
// Redis as the other replicas wrote it, so that is flushed when it moves; keys outside the prefix stay.
func TestACacheStartedWithoutRedisMovesThereWhenItAnswersAndFlushesWhatItOwes(t *testing.T) {
	mr, c := downRedis(t)
	if c.IsConnected() {
		t.Fatal("connected to a Redis that is down")
	}
	ctx := context.Background()
	c.Set(ctx, "prod|mine", 1, time.Minute)
	if err := c.FlushAll(ctx); err != nil { // a cluster change taken while in memory
		t.Fatal(err)
	}
	c.Set(ctx, "prod|mine", 1, time.Minute)
	done := reconnect(t, c)

	// written while the stand-in is down, there when it answers
	if err := mr.Set(Prefix+"prod|cluster_overview|as:x", "1"); err != nil { // another replica's entry from before the change
		t.Fatal(err)
	}
	if err := mr.Set("other-app:key", "x"); err != nil {
		t.Fatal(err)
	}
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
	within(t, 5*time.Second, c.IsConnected)
	<-done // Reconnect returns once it moved

	c.mu.RLock()
	kept := len(c.mem)
	c.mu.RUnlock()
	if kept != 0 {
		t.Fatalf("%d entries stayed in memory after the move", kept)
	}
	var got int
	if c.Get(ctx, "prod|mine", &got) {
		t.Fatal("the entry kept in memory is still read")
	}
	if mr.Exists(Prefix + "prod|cluster_overview|as:x") {
		t.Fatal("the flush owed for the change taken in memory was not done in Redis")
	}
	if !mr.Exists("other-app:key") {
		t.Fatal("a key outside the prefix went")
	}
	c.Set(ctx, "prod|after", 2, time.Minute)
	if !mr.Exists(Prefix + "prod|after") {
		t.Fatal("a Set after the move did not go to Redis")
	}
}

// With no change taken while in memory, the move flushes nothing: the other replicas' entries stay.
func TestAMoveWithNothingOwedFlushesNothing(t *testing.T) {
	mr, c := downRedis(t)
	c.Set(context.Background(), "prod|mine", 1, time.Minute)
	reconnect(t, c)
	if err := mr.Set(Prefix+"prod|cluster_overview|as:x", "1"); err != nil {
		t.Fatal(err)
	}
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
	within(t, 5*time.Second, c.IsConnected)
	if !mr.Exists(Prefix + "prod|cluster_overview|as:x") {
		t.Fatal("a move with nothing owed flushed the cache in Redis")
	}
}

// A cache with no Redis set up, or already in Redis, has nothing to move: Reconnect returns at once.
func TestReconnectReturnsAtOnceWithNothingToMove(t *testing.T) {
	mr := miniredis.RunT(t)
	for name, c := range map[string]*Cache{"no host": New("", 0, 0, ""), "in redis": cacheOn(t, mr)} {
		done := make(chan struct{})
		go func() { c.Reconnect(context.Background(), time.Hour); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: Reconnect kept waiting", name)
		}
	}
}
