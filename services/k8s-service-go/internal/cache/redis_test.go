package cache

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

func logs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// The chart leaves REDIS_HOST empty when redis.enabled is false: no connection attempt, the in-memory cache.
func TestNoHostIsTheInMemoryCacheWithoutAnAttempt(t *testing.T) {
	buf := logs(t)
	c := New("", 6379, 0, "")
	if c.IsConnected() || c.rdb != nil {
		t.Fatal("no host must not connect")
	}
	if out := buf.String(); !strings.Contains(out, "redis off") || strings.Contains(out, "not available") {
		t.Fatalf("an info line, not the unreachable warning: %s", out)
	}
	ctx := context.Background()
	c.Set(ctx, "k", map[string]int{"n": 1}, time.Minute)
	var got map[string]int
	if !c.Get(ctx, "k", &got) || got["n"] != 1 {
		t.Fatalf("in-memory get: %v", got)
	}
}

// A host that does not answer still falls back, with the warning (a set-up Redis that is down).
func TestUnreachableHostFallsBackWithAWarning(t *testing.T) {
	buf := logs(t)
	c := New("127.0.0.1", 1, 0, "")
	if c.IsConnected() {
		t.Fatal("port 1 must not connect")
	}
	if !strings.Contains(buf.String(), "redis not available") {
		t.Fatalf("warning expected: %s", buf.String())
	}
}

// A hit for a recorded AI tool call is listed as answered from the cache, by
// the key without its cluster and identity parts; a miss lists nothing.
func TestGetListsAHitForARecordedCall(t *testing.T) {
	c := New("", 0, 0, "")
	rec := &accesstrail.Recorder{}
	ctx := accesstrail.NewContext(context.Background(), rec)
	var out map[string]string
	if c.Get(ctx, "a|resource_yaml:pods:shop:web|as:0123abcd", &out) {
		t.Fatal("hit on an empty cache")
	}
	c.Set(ctx, "a|resource_yaml:pods:shop:web|as:0123abcd", map[string]string{"k": "v"}, time.Minute)
	if !c.Get(ctx, "a|resource_yaml:pods:shop:web|as:0123abcd", &out) || out["k"] != "v" {
		t.Fatalf("no hit: %v", out)
	}
	trail := rec.Snapshot()
	if trail.Total != 1 || trail.Requests[0] != (accesstrail.Request{Source: "cache", Cache: "cache resource_yaml:pods:shop:web"}) {
		t.Fatalf("trail %+v", trail)
	}
}

// Redis off, DeletePattern removes what SCAN MATCH would have found, and only that.
func TestDeletePatternInMemoryFollowsTheRedisRules(t *testing.T) {
	cases := []struct {
		pattern string
		key     string
		removed bool
	}{
		{"helm|releases|*", "helm|releases|c1|0123abcd|default|all", true},
		{"helm|releases|*", "helm|releases|c2||team-a|failed", true},
		{"helm|releases|*", "helm|releases|", true},
		{"helm|releases|*", "helm|releases|team/a|0123abcd||", true},
		{"helm|releases|*", "helm|release", false},
		{"helm|releases|*", "xhelm|releases|c1", false},
		{"helm|releases|*", "c1|yaml|nodes||n1|as:0123abcd", false},

		{"c1|yaml|nodes||n1|as:*", "c1|yaml|nodes||n1|as:0123abcd", true},
		{"c1|yaml|nodes||n1|as:*", "c1|yaml|nodes||n1|as:", true},
		{"c1|yaml|nodes||n1|as:*", "c2|yaml|nodes||n1|as:0123abcd", false},
		{"c1|yaml|nodes||n1|as:*", "c1|yaml|nodes||n10|as:0123abcd", false},
		{"c1|yaml|nodes||n1|as:*", "c1|yaml|nodes||n1", false},

		{"*", "anything|at/all", true},
		{"exact", "exact", true},
		{"exact", "exactly", false},
		{"h?llo", "hello", true},
		{"h?llo", "hallo", true},
		{"h?llo", "hllo", false},
		{"h*llo", "hllo", true},
		{"h*llo", "heeeello", true},
		{"h*llo", "hellox", false},
		{"a*b*c", "axxbyyc", true},
		{"a*b*c", "axxbyy", false},
		{"a*b*c", "abcbc", true},
		{"**", "x", true},
		{"h[ae]llo", "hello", true},
		{"h[ae]llo", "hallo", true},
		{"h[ae]llo", "hillo", false},
		{"h[^e]llo", "hallo", true},
		{"h[^e]llo", "hello", false},
		{"h[a-b]llo", "hbllo", true},
		{"h[a-b]llo", "hcllo", false},
		{"h[b-a]llo", "hallo", true},
		{`h\*llo`, "h*llo", true},
		{`h\*llo`, "hello", false},
		{`h[\]]llo`, "h]llo", true},
		{`tail\`, `tail\`, true},
		{"h[ae", "ha", true},
		{"h[ae", "hi", false},
	}
	for _, tc := range cases {
		t.Run(tc.pattern+" on "+tc.key, func(t *testing.T) {
			c := New("", 0, 0, "")
			ctx := context.Background()
			c.Set(ctx, tc.key, "old", time.Minute)
			c.DeletePattern(ctx, tc.pattern)
			var got string
			if hit := c.Get(ctx, tc.key, &got); hit == tc.removed {
				t.Fatalf("hit=%v after DeletePattern(%q), want removed=%v", hit, tc.pattern, tc.removed)
			}
		})
	}
}

// A write's pattern removes every identity's entry, for a cluster, and leaves the other entries readable.
func TestDeletePatternInMemoryRemovesEveryMatchAndKeepsTheRest(t *testing.T) {
	c := New("", 0, 0, "")
	ctx := context.Background()
	gone := []string{"helm|releases|c1|admin|default|all", "helm|releases|c1|reader|default|all", "helm|releases|c2|admin||"}
	kept := []string{"c1|resource-graph|ns|as:admin", "c1|yaml|nodes||n1|as:admin"}
	for _, k := range append(append([]string{}, gone...), kept...) {
		c.Set(ctx, k, k, time.Minute)
	}
	c.DeletePattern(ctx, "helm|releases|*")
	var got string
	for _, k := range gone {
		if c.Get(ctx, k, &got) {
			t.Errorf("%s still cached: %q", k, got)
		}
	}
	for _, k := range kept {
		if !c.Get(ctx, k, &got) || got != k {
			t.Errorf("%s lost: %q", k, got)
		}
	}
}

// A key written after the invalidation is the new answer: it stays.
func TestDeletePatternInMemoryKeepsAnEntryWrittenAfterIt(t *testing.T) {
	c := New("", 0, 0, "")
	ctx := context.Background()
	key := "helm|releases|c1|admin||"
	c.Set(ctx, key, "before", time.Minute)
	c.DeletePattern(ctx, "helm|releases|*")
	c.Set(ctx, key, "after", time.Minute)
	var got string
	if !c.Get(ctx, key, &got) || got != "after" {
		t.Fatalf("got %q", got)
	}
}

// An entry is only removed when read after it expired, so an entry nobody reads again would stay; the scan removes those too.
func TestDeletePatternInMemoryRemovesExpiredEntries(t *testing.T) {
	c := New("", 0, 0, "")
	ctx := context.Background()
	c.Set(ctx, "expired|other", "x", time.Nanosecond)
	c.Set(ctx, "live|other", "x", time.Minute)
	time.Sleep(time.Millisecond)
	c.DeletePattern(ctx, "helm|releases|*")
	c.mu.RLock()
	defer c.mu.RUnlock()
	if _, ok := c.mem["expired|other"]; ok {
		t.Fatal("the expired entry stayed")
	}
	if _, ok := c.mem["live|other"]; !ok {
		t.Fatal("the live entry was removed")
	}
}

func TestDeletePatternInMemoryIsSafeWithConcurrentReadsAndWrites(t *testing.T) {
	c := New("", 0, 0, "")
	ctx := context.Background()
	var wg sync.WaitGroup
	for w := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var got string
			for i := range 500 {
				key := fmt.Sprintf("helm|releases|c%d|%d", w, i%20)
				c.Set(ctx, key, "v", time.Minute)
				c.Get(ctx, key, &got)
				if i%50 == 0 {
					c.DeletePattern(ctx, "helm|releases|*")
				}
			}
		}()
	}
	wg.Wait()
	c.DeletePattern(ctx, "helm|releases|*")
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.mem) != 0 {
		t.Fatalf("%d entries left", len(c.mem))
	}
}
