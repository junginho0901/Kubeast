package cache

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

// cacheOn connects a Cache to a Redis stand-in.
func cacheOn(t *testing.T, mr *miniredis.Miniredis) *Cache {
	t.Helper()
	port, err := strconv.Atoi(mr.Port())
	if err != nil {
		t.Fatal(err)
	}
	c := New(mr.Host(), port, 0, "")
	if !c.IsConnected() {
		t.Fatal("not connected to the stand-in")
	}
	return c
}

// Every key the cache writes in Redis is under Prefix; get, delete and delete by pattern find it there, and a key of
// the same name outside the prefix is not the cache's.
func TestTheCacheKeepsItsKeysUnderThePrefix(t *testing.T) {
	mr := miniredis.RunT(t)
	c := cacheOn(t, mr)
	ctx := context.Background()
	c.Set(ctx, "prod|cluster_overview|as:0123abcd", 1, time.Minute)
	c.Set(ctx, "prod|pods|as:0123abcd", 2, time.Minute)
	c.Set(ctx, "helm|releases-generation", "x", time.Hour)
	if err := mr.Set("prod|cluster_overview|as:0123abcd", "9"); err != nil { // another application's key of that name
		t.Fatal(err)
	}
	for _, k := range mr.Keys() {
		if !strings.HasPrefix(k, Prefix) && k != "prod|cluster_overview|as:0123abcd" {
			t.Fatalf("the cache wrote %q outside %s", k, Prefix)
		}
	}
	var got int
	if !c.Get(ctx, "prod|cluster_overview|as:0123abcd", &got) || got != 1 {
		t.Fatalf("Get = %d, want the cache's 1", got)
	}
	c.Delete(ctx, "prod|cluster_overview|as:0123abcd")
	if c.Get(ctx, "prod|cluster_overview|as:0123abcd", &got) {
		t.Fatal("Delete left the entry")
	}
	c.DeletePattern(ctx, "prod|pods|as:*")
	if c.Get(ctx, "prod|pods|as:0123abcd", &got) {
		t.Fatal("DeletePattern left the entry")
	}
	if v, err := mr.Get("prod|cluster_overview|as:0123abcd"); err != nil || v != "9" {
		t.Fatalf("the key outside the prefix became %q, %v", v, err)
	}
}

// The flush after a cluster's registration changed empties the cache past one SCAN step and touches no key outside
// the prefix: another application's, or one Kubeast keeps for longer.
func TestFlushAllInRedisDeletesOnlyThePrefix(t *testing.T) {
	mr := miniredis.RunT(t)
	c := cacheOn(t, mr)
	ctx := context.Background()
	for i := range 2*flushBatch + 7 {
		c.Set(ctx, fmt.Sprintf("c%d|cluster_overview|as:0123abcd", i), i, time.Minute)
	}
	c.Set(ctx, "helm|releases-generation", "x", time.Hour)
	if err := mr.Set("other-app:session:1", "x"); err != nil {
		t.Fatal(err)
	}
	mr.HSet("kubeast:sync:cluster-versions", "c:prod", "3")
	if err := mr.Set("kubeast:cachenot", "x"); err != nil { // shares the start, not the prefix
		t.Fatal(err)
	}

	if err := c.FlushAll(ctx); err != nil {
		t.Fatal(err)
	}
	keys := mr.Keys()
	want := []string{"kubeast:cachenot", "kubeast:sync:cluster-versions", "other-app:session:1"}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Fatalf("left %d keys %v, want %v", len(keys), keys[:min(len(keys), 5)], want)
	}
}

// Without Redis the flush empties the process's own cache, as before.
func TestFlushAllInMemoryEmptiesTheCache(t *testing.T) {
	c := New("", 0, 0, "")
	ctx := context.Background()
	c.Set(ctx, "c1|cluster_overview", 1, time.Minute)
	if err := c.FlushAll(ctx); err != nil {
		t.Fatal(err)
	}
	var got int
	if c.Get(ctx, "c1|cluster_overview", &got) {
		t.Fatal("entry stayed")
	}
}

// An entry set without a positive TTL is kept for MaxTTL, in Redis and in memory, and the first such Set says so once:
// nothing the cache writes stays for ever.
func TestASetWithoutAPositiveTTLIsKeptForTheLongestTTL(t *testing.T) {
	buf := logs(t)
	mr := miniredis.RunT(t)
	c := cacheOn(t, mr)
	ctx := context.Background()
	c.Set(ctx, "prod|forever", 1, 0)
	c.Set(ctx, "prod|negative", 1, -time.Second)
	for _, k := range []string{"prod|forever", "prod|negative"} {
		if ttl := mr.TTL(Prefix + k); ttl != MaxTTL {
			t.Fatalf("%s kept for %v in Redis, want %v", k, ttl, MaxTTL)
		}
	}
	if n := strings.Count(buf.String(), "without a positive TTL"); n != 1 {
		t.Fatalf("said %d times, want once: %s", n, buf.String())
	}

	m := New("", 0, 0, "")
	m.Set(ctx, "prod|forever", 1, 0)
	m.mu.RLock()
	e := m.mem["prod|forever"]
	m.mu.RUnlock()
	if left := time.Until(e.expires); left < MaxTTL-time.Minute || left > MaxTTL {
		t.Fatalf("kept in memory for %v, want %v", left, MaxTTL)
	}
}
