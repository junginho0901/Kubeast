package main

import (
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
)

// The chart's redis.acl turns the default user off: the client of clustersync's change notices signs in as
// REDIS_USERNAME with the cache, or every publish and subscribe is refused and no replica hears of a change.
func TestClusterNoticesSignsInAsTheCacheUser(t *testing.T) {
	cfg := config.Config{RedisHost: "redis", RedisPort: 6380, RedisDB: 2, RedisUsername: "k8s-service", RedisPassword: "pw-k8s"}
	c := clusterNotices(cfg)
	if c == nil {
		t.Fatal("no client with REDIS_HOST set")
	}
	defer c.Close()
	o := c.Options()
	if o.Username != "k8s-service" || o.Password != "pw-k8s" {
		t.Fatalf("signs in as %q with password %q, want k8s-service with pw-k8s", o.Username, o.Password)
	}
	if o.Addr != "redis:6380" || o.DB != 2 {
		t.Fatalf("connects to %s db %d, want redis:6380 db 2", o.Addr, o.DB)
	}
}

func TestClusterNoticesNoneWithoutRedis(t *testing.T) {
	if c := clusterNotices(config.Config{RedisUsername: "k8s-service"}); c != nil {
		t.Fatalf("a client with REDIS_HOST empty: %v", c.Options().Addr)
	}
}
