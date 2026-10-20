package cache

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"
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
