package cache

import (
	"context"
	"fmt"
	"strconv"
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

// The flush after a cluster's registration changed empties the shared cache and leaves what the replicas keep for
// each other (internal/clustersync), past one SCAN step.
func TestFlushAllInRedisKeepsTheSyncKeys(t *testing.T) {
	mr := miniredis.RunT(t)
	c := cacheOn(t, mr)
	ctx := context.Background()
	for i := range 2*flushBatch + 7 {
		c.Set(ctx, fmt.Sprintf("c%d|cluster_overview|as:0123abcd", i), i, time.Minute)
	}
	c.Set(ctx, "helm|releases-generation", "x", time.Hour)
	mr.HSet(KeptPrefix+"cluster-versions", "epoch", "e1", "c:prod", "3")

	if err := c.FlushAll(ctx); err != nil {
		t.Fatal(err)
	}
	keys := mr.Keys()
	if len(keys) != 1 || keys[0] != KeptPrefix+"cluster-versions" {
		t.Fatalf("left %d keys, want only the versions: %v", len(keys), keys[:min(len(keys), 5)])
	}
	if got := mr.HGet(KeptPrefix+"cluster-versions", "c:prod"); got != "3" {
		t.Fatalf("version %q after the flush", got)
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
