package k8s

import (
	"context"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// A cached cluster answer is keyed by the cluster and by the signed-in
// identity: a Read user must not get what an admin's request cached.

func TestClusterCacheKey_PerIdentity(t *testing.T) {
	s := &Service{}
	base := cluster.WithID(context.Background(), "a")
	admin := auth.WithPayload(base, auth.TokenPayload{UserID: "1", Email: "admin@example.com", Roles: map[string]string{"a": "Admin"}})
	reader := auth.WithPayload(base, auth.TokenPayload{UserID: "2", Email: "reader@example.com", Roles: map[string]string{"a": "Read"}})
	readerB := auth.WithPayload(cluster.WithID(context.Background(), "b"), auth.TokenPayload{UserID: "2", Email: "reader@example.com", Roles: map[string]string{"a": "Read"}})

	ka, kr := s.clusterCacheKey(admin, "resource-graph|ns"), s.clusterCacheKey(reader, "resource-graph|ns")
	if ka == kr {
		t.Fatalf("admin and reader share the key %q", ka)
	}
	if kr != s.clusterCacheKey(reader, "resource-graph|ns") {
		t.Fatal("the same identity got two keys")
	}
	if kr == s.clusterCacheKey(readerB, "resource-graph|ns") {
		t.Fatal("two clusters share a key")
	}
	if got := s.clusterCacheKey(base, "resource-graph|ns"); got != "a|resource-graph|ns" {
		t.Fatalf("no signed-in user: key %q, want the cluster alone", got)
	}
}

func TestDropCached_RemovesTheWritersEntry(t *testing.T) {
	s := &Service{cache: cache.New("127.0.0.1", 1, 0, "")} // nothing listens: in-memory cache
	ctx := auth.WithPayload(cluster.WithID(context.Background(), "a"), auth.TokenPayload{UserID: "1", Email: "admin@example.com"})
	key := s.clusterCacheKey(ctx, "yaml|nodes||n1")
	s.cache.Set(ctx, key, "old", time.Minute)
	var got string
	if !s.cache.Get(ctx, key, &got) {
		t.Fatal("entry not cached")
	}

	s.dropCached(ctx, "yaml|nodes||n1")
	if s.cache.Get(ctx, key, &got) {
		t.Fatalf("entry still cached after the write: %q", got)
	}
}
