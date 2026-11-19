package cache

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

// onStandIn is a cache connected to a Redis stand-in; Close and Restart stop and start it on the same address.
func onStandIn(t *testing.T, skip time.Duration) (*miniredis.Miniredis, *Cache) {
	t.Helper()
	mr := miniredis.RunT(t)
	port, err := strconv.Atoi(mr.Port())
	if err != nil {
		t.Fatal(err)
	}
	c := New(mr.Host(), port, 0, "")
	if !c.IsConnected() {
		t.Fatal("not connected to the stand-in")
	}
	c.skipFor = skip
	return mr, c
}

// skipping stops the stand-in, reads once so the skip starts, and starts the stand-in again.
func skipping(t *testing.T, mr *miniredis.Miniredis, c *Cache) {
	t.Helper()
	mr.Close()
	var got string
	if c.Get(context.Background(), "k", &got) {
		t.Fatal("a hit from a stopped Redis")
	}
	if c.skipUntil.Load() == 0 {
		t.Fatal("a read Redis did not answer started no skip")
	}
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
}

func TestReadsAndStoresLeaveRedisOutForAWhileAfterItDidNotAnswerAndUseItAgainAfter(t *testing.T) {
	buf := logs(t)
	mr, c := onStandIn(t, 300*time.Millisecond)
	skipping(t, mr, c)
	ctx := context.Background()
	var got string

	// Redis answers again, but the skip is not over: nothing goes there
	before := mr.CommandCount()
	c.Set(ctx, "during", "v", time.Minute)
	if c.Get(ctx, "during", &got) || c.Peek(ctx, "during", &got) {
		t.Fatal("a hit while Redis is left out")
	}
	if n := mr.CommandCount() - before; n != 0 {
		t.Fatalf("%d commands went to Redis during the skip", n)
	}
	if mr.Exists(Prefix + "during") {
		t.Fatal("a store during the skip reached Redis")
	}
	if !c.IsConnected() {
		t.Fatal("the skip left Redis for the map")
	}

	// once it is over the next store goes to Redis and is read from there; no entry went to the map
	time.Sleep(350 * time.Millisecond)
	c.Set(ctx, "back", "v", time.Minute)
	if !mr.Exists(Prefix + "back") {
		t.Fatal("the store after the skip did not reach Redis")
	}
	if !c.Get(ctx, "back", &got) || got != "v" {
		t.Fatalf("the read after the skip: %q", got)
	}
	if c.skipUntil.Load() != 0 {
		t.Fatal("a Redis that answered is still left out")
	}
	c.mu.RLock()
	inMap := len(c.mem)
	c.mu.RUnlock()
	if inMap != 0 {
		t.Fatalf("%d entries went to the map while Redis was left out", inMap)
	}
	out := buf.String()
	if strings.Count(out, "redis did not answer the cache") != 1 || strings.Count(out, "redis answers the cache again") != 1 {
		t.Fatalf("one line when Redis is left out and one when it answers again:\n%s", out)
	}
}

// What an invalidation sends (Delete, DeletePattern, the generation mark, FlushAll) still goes to Redis during the
// skip: a skip begun by one lost answer must not leave an entry the change made stale.
func TestInvalidationsStillGoToRedisDuringTheSkip(t *testing.T) {
	ctx := context.Background()
	for name, run := range map[string]func(*Cache){
		"Delete":        func(c *Cache) { c.Delete(ctx, "old") },
		"DeletePattern": func(c *Cache) { c.DeletePattern(ctx, "ol*") },
		"FlushAll":      func(c *Cache) { _ = c.FlushAll(ctx) },
	} {
		t.Run(name, func(t *testing.T) {
			mr, c := onStandIn(t, time.Minute)
			if err := mr.Set(Prefix+"old", `"x"`); err != nil {
				t.Fatal(err)
			}
			skipping(t, mr, c)
			run(c)
			if mr.Exists(Prefix + "old") {
				t.Fatalf("%s during the skip left the entry in Redis", name)
			}
			// Redis answered it: the skip is over
			c.Set(ctx, "after", "v", time.Minute)
			if !mr.Exists(Prefix + "after") {
				t.Fatalf("a store after Redis answered %s stayed out of Redis", name)
			}
		})
	}
	t.Run("Mark", func(t *testing.T) {
		mr, c := onStandIn(t, time.Minute)
		skipping(t, mr, c)
		c.Mark(ctx, "gen", "m2", time.Minute)
		var got string
		if !c.Peek(ctx, "gen", &got) || got != "m2" {
			t.Fatalf("the mark written during the skip: %q", got)
		}
	})
}

// A command cut short by its own request (the browser left) says nothing about Redis.
func TestARequestThatEndedStartsNoSkip(t *testing.T) {
	mr, c := onStandIn(t, time.Minute)
	mr.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var got string
	c.Get(ctx, "k", &got)
	if c.skipUntil.Load() != 0 {
		t.Fatal("a request that ended started a skip")
	}
	// a miss is an answer
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
	if c.Get(context.Background(), "none", &got) {
		t.Fatal("a hit for a key never set")
	}
	if c.skipUntil.Load() != 0 {
		t.Fatal("a miss started a skip")
	}
}

// While the skip lasts one caller at a time tries Redis once it is over; the others go on leaving it out.
func TestOneCallerTriesRedisWhenTheSkipEnds(t *testing.T) {
	c := &Cache{skipFor: time.Minute}
	c.skipUntil.Store(time.Now().Add(-time.Millisecond).UnixNano())
	if !c.useRedis() {
		t.Fatal("the first caller after the skip does not try Redis")
	}
	for i := 0; i < 3; i++ {
		if c.useRedis() {
			t.Fatal("a second caller tried Redis while the first one's try is under way")
		}
	}
}
