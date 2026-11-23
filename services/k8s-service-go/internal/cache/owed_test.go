package cache

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// throughSilent is a cache connected to a Redis stand-in through a silentRedis, and the stand-in.
func throughSilent(t *testing.T) (*miniredis.Miniredis, *silentRedis, *Cache) {
	t.Helper()
	mr := miniredis.RunT(t)
	s := newSilentRedis(t, mr.Addr())
	c := New("127.0.0.1", s.port(), 0, "")
	if !c.IsConnected() {
		t.Fatal("not connected through the stand-in")
	}
	return mr, s, c
}

// The replica that changed a release lost its invalidation (Redis did not answer while it was left out): once Redis
// answers again it must not read the list from before its change. The flush it owes comes first, so the other
// replicas lose that list too.
func TestAnInvalidationRedisDidNotTakeIsFlushedBeforeTheCacheReadsRedisAgain(t *testing.T) {
	buf := logs(t)
	mr, s, c := throughSilent(t)
	other := cacheOn(t, mr)
	ctx := context.Background()
	c.Set(ctx, "helm|releases|x", []string{"old"}, time.Minute)
	if !mr.Exists(Prefix + "helm|releases|x") {
		t.Fatal("the list before the change is not in Redis")
	}

	s.silent.Store(true)
	var got []string
	c.Get(ctx, "k", &got) // Redis does not answer: left out
	c.DeletePattern(ctx, "helm|releases|*")
	if !mr.Exists(Prefix + "helm|releases|x") {
		t.Fatal("the invalidation reached a Redis that did not answer")
	}

	s.silent.Store(false)
	c.skipUntil.Store(1) // the skip is over
	if c.Get(ctx, "helm|releases|x", &got) {
		t.Fatalf("the replica that changed the release read the list from before the change: %v", got)
	}
	if mr.Exists(Prefix + "helm|releases|x") {
		t.Fatal("the list from before the change is still in Redis")
	}
	if other.Get(ctx, "helm|releases|x", &got) {
		t.Fatalf("another replica read the list from before the change: %v", got)
	}
	c.Set(ctx, "helm|releases|x", []string{"new"}, time.Minute)
	if !c.Get(ctx, "helm|releases|x", &got) || len(got) != 1 || got[0] != "new" {
		t.Fatalf("after the flush the cache does not keep entries again: %v", got)
	}
	if !strings.Contains(buf.String(), "flushed for changes Redis did not take") {
		t.Fatalf("no line for the flush:\n%s", buf.String())
	}
}

// A Redis that answers slowly (0.6 s, past the reads' 0.5 s) still takes an invalidation: those keep go-redis's tries
// within their 5 s.
func TestASlowRedisStillTakesAnInvalidation(t *testing.T) {
	mr, s, c := throughSilent(t)
	ctx := context.Background()
	c.Set(ctx, "helm|releases|x", []string{"old"}, time.Minute)
	s.delay.Store(int64(600 * time.Millisecond))
	took := timed(t, 6*time.Second, "an invalidation on a slow Redis", func() { c.DeletePattern(ctx, "helm|releases|*") })
	if mr.Exists(Prefix + "helm|releases|x") {
		t.Fatalf("a Redis answering in 0.6 s kept the entry after the invalidation (%v)", took)
	}
	if c.owed.Load() {
		t.Error("an invalidation Redis took is owed")
	}
}

// A Redis answering in 0.3 s is used: a Helm list's four commands each wait for it, nothing is left out.
func TestARedisAnsweringIn300msIsUsed(t *testing.T) {
	mr, s, c := throughSilent(t)
	ctx := context.Background()
	s.delay.Store(int64(300 * time.Millisecond))
	took := timed(t, 5*time.Second, "a Helm list's commands", func() {
		var list []string
		var mark string
		c.Get(ctx, "helm|releases|x", &list)
		c.Peek(ctx, "helm|releases-generation", &mark)
		c.Set(ctx, "helm|releases|x", []string{"a"}, time.Minute)
		c.Peek(ctx, "helm|releases-generation", &mark)
	})
	if c.skipUntil.Load() != 0 {
		t.Fatalf("a Redis answering in 0.3 s was left out (the commands took %v)", took)
	}
	if !mr.Exists(Prefix + "helm|releases|x") {
		t.Fatal("the store did not reach a Redis answering in 0.3 s")
	}
	if took < 4*300*time.Millisecond {
		t.Errorf("four commands on a Redis answering in 0.3 s took %v", took)
	}
}

// A Redis answering in 0.6 s is left out: one warning, then one try at each skip's end, which fails again without a
// second warning; when it answers in time again the cache says so once.
func TestARedisAnsweringIn600msIsLeftOutAndTriedAtEachSkipsEnd(t *testing.T) {
	buf := logs(t)
	_, s, c := throughSilent(t)
	ctx := context.Background()
	s.delay.Store(int64(600 * time.Millisecond))
	var got string
	c.Get(ctx, "k", &got)
	if c.skipUntil.Load() == 0 {
		t.Fatal("a read past 0.5 s started no skip")
	}
	sent := s.sent.Load()
	c.Get(ctx, "k", &got)
	if s.sent.Load() != sent {
		t.Fatal("a read during the skip went to Redis")
	}
	c.skipUntil.Store(1)
	c.Get(ctx, "k", &got) // the one try at the skip's end, too slow again
	if s.sent.Load() == sent {
		t.Fatal("no try at the skip's end")
	}
	if c.skipUntil.Load() <= 1 {
		t.Fatal("a try past 0.5 s did not start the skip again")
	}
	s.delay.Store(0)
	c.skipUntil.Store(1)
	c.Get(ctx, "k", &got)
	out := buf.String()
	if n := strings.Count(out, "redis did not answer the cache"); n != 1 {
		t.Errorf("%d warnings for one slow spell, want 1:\n%s", n, out)
	}
	if n := strings.Count(out, "redis answers the cache again"); n != 1 {
		t.Errorf("%d lines for Redis answering again, want 1:\n%s", n, out)
	}
}

// A read whose request ends while Redis has not answered says nothing about Redis: no skip.
func TestARequestEndingDuringACommandStartsNoSkip(t *testing.T) {
	_, s, c := throughSilent(t)
	s.silent.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	var got string
	timed(t, 3*time.Second, "a read whose request ended", func() { c.Get(ctx, "k", &got) })
	if c.skipUntil.Load() != 0 {
		t.Fatal("a read whose request ended started a skip")
	}
}

// While a debt is owed and Redis is left out, an invalidation is only counted: nothing goes to Redis, FlushAll says the
// flush is owed, and the flush that pays the debt removes what they would have.
func TestAnInvalidationWhileOwingAndLeftOutIsCountedAndTheFlushTakesItsEntries(t *testing.T) {
	mr, s, c := throughSilent(t)
	ctx := context.Background()
	c.Set(ctx, "a1", 1, time.Minute)
	s.silent.Store(true)
	var got int
	c.Get(ctx, "k", &got)  // left out
	c.Delete(ctx, "other") // not taken: owed
	if !c.owed.Load() {
		t.Fatal("an invalidation Redis did not take is not owed")
	}
	s.silent.Store(false)
	sent, owes := s.sent.Load(), c.owes.Load()
	c.DeletePattern(ctx, "a*")
	if err := c.FlushAll(ctx); !errors.Is(err, errOwed) {
		t.Fatalf("FlushAll while owing and left out: %v, want errOwed", err)
	}
	if s.sent.Load() != sent {
		t.Fatal("an invalidation while owing and left out went to Redis")
	}
	if c.owes.Load() != owes+2 {
		t.Fatalf("owes %d, want %d", c.owes.Load(), owes+2)
	}
	if !mr.Exists(Prefix + "a1") {
		t.Fatal("the entry went before the flush")
	}
	c.skipUntil.Store(1)
	if c.Get(ctx, "a1", &got) {
		t.Fatal("a hit for an entry an owed invalidation removes")
	}
	if mr.Exists(Prefix+"a1") || c.owed.Load() {
		t.Fatalf("the flush did not pay the debt (entry %v, owed %v)", mr.Exists(Prefix+"a1"), c.owed.Load())
	}
}

// A debt taken while the flush runs stays owed: the flush may have passed the entries it was for.
func TestADebtTakenDuringTheFlushStaysOwed(t *testing.T) {
	_, s, c := throughSilent(t)
	ctx := context.Background()
	c.owe()
	s.delay.Store(int64(300 * time.Millisecond))
	time.AfterFunc(100*time.Millisecond, c.owe)
	var got int
	if c.Get(ctx, "k", &got) {
		t.Fatal("a hit")
	}
	if !c.owed.Load() {
		t.Fatal("a debt taken during the flush was cleared with the one before it")
	}
	s.delay.Store(0)
	c.Get(ctx, "k", &got)
	if c.owed.Load() {
		t.Fatal("the next flush did not pay it")
	}
}

// A debt taken right while owed is cleared stays: the check that none came since and the clearing are two steps.
func TestADebtTakenRightWhileOwedIsClearedStays(t *testing.T) {
	c := cacheOn(t, miniredis.RunT(t))
	c.owe()
	c.clearing = c.owe
	c.payOwed(context.Background(), c.rdb.Load())
	if !c.owed.Load() {
		t.Fatal("a debt taken while owed was cleared is lost")
	}
}

// While the debt cannot be paid, reads and stores miss at each try, and the failure is said once until it is paid.
func TestReadsAndStoresMissWhileTheDebtCannotBePaid(t *testing.T) {
	buf := logs(t)
	mr, s, c := throughSilent(t)
	ctx := context.Background()
	c.Set(ctx, "old", 1, time.Minute)
	s.silent.Store(true)
	var got int
	c.Get(ctx, "k", &got)
	c.DeletePattern(ctx, "ol*")
	for i := 0; i < 3; i++ {
		c.skipUntil.Store(1)
		if c.Get(ctx, "old", &got) {
			t.Fatalf("try %d: a hit while the debt is not paid", i)
		}
		c.Set(ctx, "new", 1, time.Minute)
	}
	s.silent.Store(false)
	if !c.owed.Load() || mr.Exists(Prefix+"new") {
		t.Fatalf("owed %v, a store went to Redis %v", c.owed.Load(), mr.Exists(Prefix+"new"))
	}
	c.skipUntil.Store(1)
	if c.Get(ctx, "old", &got) || mr.Exists(Prefix+"old") {
		t.Fatal("the entry stayed after the debt was paid")
	}
	out := buf.String()
	if n := strings.Count(out, "the flush owed for changes Redis did not take failed"); n != 1 {
		t.Errorf("%d lines for three failed flushes of one debt, want 1:\n%s", n, out)
	}
	if n := strings.Count(out, "flushed for changes Redis did not take"); n != 1 {
		t.Errorf("%d lines for the debt paid, want 1:\n%s", n, out)
	}
}

// A replica that started while Redis did not answer keeps its cache in memory; an invalidation it takes there is owed
// in Redis, where another replica may have stored what it removes, and is flushed when it moves there.
func TestAnInvalidationTakenInMemoryWhileRedisWasSetUpIsFlushedWhenTheCacheMovesThere(t *testing.T) {
	ctx := context.Background()
	for name, run := range map[string]func(*Cache){
		"Delete":        func(c *Cache) { c.Delete(ctx, "helm|releases|x") },
		"DeletePattern": func(c *Cache) { c.DeletePattern(ctx, "helm|releases|*") },
		"Mark":          func(c *Cache) { c.Mark(ctx, "helm|releases-generation", "m2", time.Hour) },
	} {
		t.Run(name, func(t *testing.T) {
			mr := miniredis.RunT(t)
			port, err := strconv.Atoi(mr.Port())
			if err != nil {
				t.Fatal(err)
			}
			a := &Cache{mem: map[string]memEntry{}, skipFor: redisSkip, base: time.Now(),
				standby: redis.NewClient(cacheOptions(mr.Host(), port, 0, "", ""))}
			t.Cleanup(func() { _ = a.standby.Close() })
			b := cacheOn(t, mr)
			b.Set(ctx, "helm|releases|x", []string{"old"}, time.Minute)
			run(a)
			if !a.moveToRedis(ctx) {
				t.Fatal("did not move")
			}
			var got []string
			if a.Get(ctx, "helm|releases|x", &got) || mr.Exists(Prefix+"helm|releases|x") {
				t.Fatalf("the replica that took the change in memory read the list from before it: %v", got)
			}
		})
	}
}
