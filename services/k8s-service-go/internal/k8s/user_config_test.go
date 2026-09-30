package k8s

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// UserRESTConfigFor pins the ctx user on a copy of the cluster config so that
// API calls made outside the request context (the Helm SDK) still run as the
// user. The service's own config must stay untouched.

func TestUserRESTConfigFor_ImpersonationOff(t *testing.T) {
	reg := &mockRegistry{def: "a", clusters: map[cluster.ID]cluster.Info{"a": extCluster("a")}}
	s := newTestService(t, reg)

	cfg, err := s.UserRESTConfigFor(context.Background())
	if err != nil {
		t.Fatalf("UserRESTConfigFor: %v", err)
	}
	if cfg.Impersonate.UserName != "" {
		t.Fatalf("impersonation off: unexpected Impersonate %+v", cfg.Impersonate)
	}
}

func TestUserRESTConfigFor_ImpersonationOn(t *testing.T) {
	reg := &mockRegistry{def: "a", clusters: map[cluster.ID]cluster.Info{"a": extCluster("a")}}
	s, err := NewService(context.Background(), reg, false, nil, ServiceOptions{MaxClusters: 20, Impersonation: true})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	t.Cleanup(func() { impersonationEnabled = false })

	// No signed-in user: refused rather than falling back to the service account.
	if _, err := s.UserRESTConfigFor(context.Background()); !errors.Is(err, ErrNoUser) {
		t.Fatalf("no user: got err %v, want ErrNoUser", err)
	}

	payload := auth.TokenPayload{UserID: "u1", Email: "reader@example.com", Roles: map[string]string{"a": "Read"}}
	ctx := auth.WithPayload(cluster.WithID(context.Background(), "a"), payload)
	cfg, err := s.UserRESTConfigFor(ctx)
	if err != nil {
		t.Fatalf("UserRESTConfigFor: %v", err)
	}
	if cfg.Impersonate.UserName != "reader@example.com" {
		t.Fatalf("Impersonate.UserName = %q", cfg.Impersonate.UserName)
	}
	wantGroups := []string{auth.GroupAuthenticated, auth.GroupViewer}
	if !reflect.DeepEqual(cfg.Impersonate.Groups, wantGroups) {
		t.Fatalf("Impersonate.Groups = %v, want %v", cfg.Impersonate.Groups, wantGroups)
	}

	// The bundle's own config is shared by every other caller and must not gain
	// the identity.
	base, err := s.RESTConfigFor(ctx)
	if err != nil {
		t.Fatalf("RESTConfigFor: %v", err)
	}
	if base == cfg {
		t.Fatal("UserRESTConfigFor returned the shared bundle config instead of a copy")
	}
	if base.Impersonate.UserName != "" || len(base.Impersonate.Groups) != 0 {
		t.Fatalf("shared config gained Impersonate %+v", base.Impersonate)
	}
}
