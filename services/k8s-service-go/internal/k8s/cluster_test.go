package k8s

import (
	"context"
	"errors"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// A minimal but valid kubeconfig. buildClientBundle only constructs clients
// (no connection), so this is enough to exercise For/Default without a cluster.
const testKubeconfig = `apiVersion: v1
kind: Config
clusters:
- name: test
  cluster:
    server: https://127.0.0.1:6443
    insecure-skip-tls-verify: true
contexts:
- name: test
  context:
    cluster: test
    user: test
current-context: test
users:
- name: test
  user:
    token: abc
`

type mockRegistry struct {
	clusters map[cluster.ID]cluster.Info
	def      cluster.ID
}

func (m *mockRegistry) List(context.Context) ([]cluster.Info, error) {
	out := make([]cluster.Info, 0, len(m.clusters))
	for _, i := range m.clusters {
		out = append(out, i)
	}
	return out, nil
}

func (m *mockRegistry) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	i, ok := m.clusters[id]
	if !ok {
		return nil, cluster.ErrNotFound
	}
	return &i, nil
}

func (m *mockRegistry) Default(context.Context) (cluster.ID, error) {
	if m.def == "" {
		return "", cluster.ErrNotFound
	}
	return m.def, nil
}

func extCluster(id cluster.ID) cluster.Info {
	return cluster.Info{ID: id, Mode: cluster.ModeExternal, KubeconfigBlob: testKubeconfig}
}

func newTestService(t *testing.T, reg cluster.Registry) *Service {
	t.Helper()
	s, err := NewService(context.Background(), reg, false, nil, ServiceOptions{MaxClusters: 20})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	return s
}

func TestService_ForDistinctClusters(t *testing.T) {
	reg := &mockRegistry{def: "a", clusters: map[cluster.ID]cluster.Info{
		"a": extCluster("a"),
		"b": extCluster("b"),
	}}
	s := newTestService(t, reg)

	ba, err := s.For(context.Background(), "a")
	if err != nil {
		t.Fatalf("For(a): %v", err)
	}
	bb, err := s.For(context.Background(), "b")
	if err != nil {
		t.Fatalf("For(b): %v", err)
	}
	if ba == bb {
		t.Error("expected distinct bundles for different clusters")
	}
	if ba2, _ := s.For(context.Background(), "a"); ba2 != ba {
		t.Error("expected cached bundle on second For(a)")
	}
}

func TestService_Default(t *testing.T) {
	reg := &mockRegistry{def: "a", clusters: map[cluster.ID]cluster.Info{"a": extCluster("a")}}
	s := newTestService(t, reg)
	def, err := s.Default(context.Background())
	if err != nil {
		t.Fatalf("Default: %v", err)
	}
	if fa, _ := s.For(context.Background(), "a"); def != fa {
		t.Error("Default should equal For(default id)")
	}
}

func TestService_ForUnknown(t *testing.T) {
	reg := &mockRegistry{def: "a", clusters: map[cluster.ID]cluster.Info{"a": extCluster("a")}}
	s := newTestService(t, reg)
	if _, err := s.For(context.Background(), "nope"); !errors.Is(err, cluster.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestService_Unconfigured(t *testing.T) {
	s := newTestService(t, &mockRegistry{}) // no clusters, empty default
	if _, err := s.Default(context.Background()); !errors.Is(err, cluster.ErrNotFound) {
		t.Errorf("expected ErrNotFound for unconfigured, got %v", err)
	}
	if s.Clientset() != nil {
		t.Error("expected nil clientset when unconfigured")
	}
}

func TestService_ForCtx(t *testing.T) {
	reg := &mockRegistry{def: "a", clusters: map[cluster.ID]cluster.Info{
		"a": extCluster("a"),
		"b": extCluster("b"),
	}}
	s := newTestService(t, reg)

	// No cluster in ctx -> default.
	def, _ := s.Default(context.Background())
	d, err := s.ForCtx(context.Background())
	if err != nil || d != def {
		t.Errorf("ForCtx(no cluster) should be default, got %v err=%v", d, err)
	}
	// Cluster in ctx -> that cluster.
	ctx := cluster.WithID(context.Background(), "b")
	got, err := s.ForCtx(ctx)
	if err != nil {
		t.Fatalf("ForCtx(b): %v", err)
	}
	if fb, _ := s.For(context.Background(), "b"); got != fb {
		t.Error("ForCtx(b) should equal For(b)")
	}
}
