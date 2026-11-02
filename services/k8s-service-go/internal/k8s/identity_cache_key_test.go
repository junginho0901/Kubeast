package k8s

import (
	"context"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// A handler's cached answer (the timeline's) is kept per cluster and per identity:
// one user's answer is never another's, and the same user finds their own again.
func TestIdentityCacheKey_PerClusterAndIdentity(t *testing.T) {
	s := &Service{}
	at := func(clusterID string, p auth.TokenPayload) string {
		return s.IdentityCacheKey(auth.WithPayload(cluster.WithID(context.Background(), cluster.ID(clusterID)), p), "timeline|ns||hours=24")
	}
	admin := auth.TokenPayload{Email: "admin@kubeast.local", Perms: map[string][]string{"*": {"*"}}}
	reader := auth.TokenPayload{Email: "reader@kubeast.local", Roles: map[string]string{"self": "Read"}, Namespaces: map[string][]string{"self": {"default"}}}
	if at("self", admin) == at("self", reader) {
		t.Fatal("the admin and a namespace-scoped reader share a timeline key")
	}
	if at("self", reader) != at("self", reader) {
		t.Fatal("the same reader gets two keys for one timeline")
	}
	if at("self", reader) == at("test2", reader) {
		t.Fatal("one reader shares a timeline key across clusters")
	}
}
