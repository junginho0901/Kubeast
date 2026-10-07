package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// A minimal but valid kubeconfig: the bundle is only constructed, never used.
const middlewareKubeconfig = `apiVersion: v1
kind: Config
clusters:
- name: test
  cluster:
    server: https://127.0.0.1:6443
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

type middlewareRegistry struct{}

func (middlewareRegistry) List(context.Context) ([]cluster.Info, error) { return nil, nil }

func (middlewareRegistry) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	switch id {
	case "known":
		return &cluster.Info{ID: id, Mode: cluster.ModeExternal, KubeconfigBlob: middlewareKubeconfig}, nil
	case "flaky":
		return nil, errors.New("registry: connection refused")
	}
	return nil, cluster.ErrNotFound
}

func (middlewareRegistry) Default(context.Context) (cluster.ID, error) {
	return "", cluster.ErrNotFound
}

func TestClusterMiddlewareUnknownClusterIs404(t *testing.T) {
	svc, err := k8s.NewService(context.Background(), middlewareRegistry{}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{svc: svc}
	admin := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"menu.dashboard"}}}

	cases := []struct {
		query  string
		status int
		next   bool
	}{
		{"?cluster=nope", http.StatusNotFound, false},
		{"?cluster=known", http.StatusOK, true},
		{"?cluster=flaky", http.StatusOK, true}, // not a 404: the handler decides
		{"", http.StatusOK, true},
	}
	for _, tc := range cases {
		called := false
		mw := h.ClusterMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
		req := httptest.NewRequest(http.MethodGet, "/api/v1/namespaces"+tc.query, nil)
		req = req.WithContext(auth.WithPayload(req.Context(), admin))
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, req)
		if rec.Code != tc.status || called != tc.next {
			t.Errorf("%q: status %d next=%v, want %d next=%v (body %s)", tc.query, rec.Code, called, tc.status, tc.next, rec.Body.String())
		}
	}
}
