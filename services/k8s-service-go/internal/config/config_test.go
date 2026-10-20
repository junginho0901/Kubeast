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
