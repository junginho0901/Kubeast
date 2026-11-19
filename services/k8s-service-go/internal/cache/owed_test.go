package cache

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
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
