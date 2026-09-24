package ws

import (
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

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
