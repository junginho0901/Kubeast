package ws

import (
	"context"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// An empty clusterId is the connection's cluster, so a subscription is gated on
// the cluster it actually watches.
func TestSubscriptionCluster(t *testing.T) {
	conn := cluster.WithID(context.Background(), "self")
	if got := subscriptionCluster(conn, ""); got != "self" {
		t.Errorf("empty clusterId: got %q want self", got)
	}
	if got := subscriptionCluster(conn, "alpha"); got != "alpha" {
		t.Errorf("explicit clusterId: got %q want alpha", got)
	}
	if got := subscriptionCluster(context.Background(), ""); got != "" {
		t.Errorf("no connection cluster: got %q want empty", got)
	}
	viewer := auth.TokenPayload{Perms: auth.PermissionMatrix{"default": {"resource.*.read"}}}
	if canWatchCluster(viewer, subscriptionCluster(conn, "")) {
		t.Error("a grant on \"default\" must not open the connection's cluster self")
	}
}

func TestCanWatchCluster(t *testing.T) {
	admin := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"*"}}}
	viewer := auth.TokenPayload{Perms: auth.PermissionMatrix{"alpha": {"resource.*.read"}}}
	nobody := auth.TokenPayload{Perms: auth.PermissionMatrix{}}

	cases := []struct {
		name    string
		payload auth.TokenPayload
		cluster string
		want    bool
	}{
		{"admin any cluster", admin, "prod", true},
		{"admin default", admin, "", true},
		{"viewer own cluster", viewer, "alpha", true},
		{"viewer other cluster", viewer, "prod", false},
		{"viewer empty falls back to default", viewer, "", false},
		{"no grants", nobody, "alpha", false},
	}
	for _, c := range cases {
		if got := canWatchCluster(c.payload, c.cluster); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}
