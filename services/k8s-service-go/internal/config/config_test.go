package config

import "testing"

// REDIS_HOST set to nothing (chart redis.enabled false) is no Redis; absent is the local default.
func TestRedisHostEmptyMeansNoRedis(t *testing.T) {
	t.Setenv("REDIS_HOST", "")
	if got := Load().RedisHost; got != "" {
		t.Fatalf("empty REDIS_HOST must stay empty, got %q", got)
	}
	t.Setenv("REDIS_HOST", "redis")
	if got := Load().RedisHost; got != "redis" {
		t.Fatalf("got %q", got)
	}
}

// The server's cap on its terminals and followed logs is the chart's default (multicluster.maxStreamsPerServer) when
// unset, so compose, which sets none, gets the same; 0 is no cap, not the default.
func TestTheServersStreamCapIsTheChartsDefaultUnlessSet(t *testing.T) {
	t.Setenv("MAX_STREAMS_PER_SERVER", "")
	if got := Load().MaxStreamsPerServer; got != 443 {
		t.Fatalf("unset MAX_STREAMS_PER_SERVER = %d, want 443", got)
	}
	t.Setenv("MAX_STREAMS_PER_SERVER", "0")
	if got := Load().MaxStreamsPerServer; got != 0 {
		t.Fatalf("MAX_STREAMS_PER_SERVER=0 = %d, want 0 (no cap)", got)
	}
	t.Setenv("MAX_STREAMS_PER_SERVER", "50")
	if got := Load().MaxStreamsPerServer; got != 50 {
		t.Fatalf("MAX_STREAMS_PER_SERVER=50 = %d", got)
	}
}
