package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
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

type middlewareRegistry struct {
	def    cluster.ID
	defErr error
}

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

func (r middlewareRegistry) Default(context.Context) (cluster.ID, error) {
	if r.defErr != nil {
		return "", r.defErr
	}
	if r.def == "" {
		return "", cluster.ErrNotFound
	}
	return r.def, nil
}

// Without ?cluster= the registry's default is resolved once and used for the
// access check and the data alike: a grant on a cluster that merely happens to
// be called "default" does not open the real default cluster.
func TestClusterMiddlewareResolvesDefaultCluster(t *testing.T) {
	cases := []struct {
		name   string
		reg    middlewareRegistry
		perms  auth.PermissionMatrix
		query  string
		status int
		ctxID  cluster.ID
	}{
		{"grant on default only", middlewareRegistry{def: "known"}, auth.PermissionMatrix{"default": {"resource.*.read"}}, "", http.StatusForbidden, ""},
		{"grant on the default cluster", middlewareRegistry{def: "known"}, auth.PermissionMatrix{"known": {"resource.*.read"}}, "", http.StatusOK, "known"},
		{"explicit cluster unchanged", middlewareRegistry{def: "known"}, auth.PermissionMatrix{"known": {"resource.*.read"}}, "?cluster=known", http.StatusOK, "known"},
		{"nothing registered", middlewareRegistry{}, auth.PermissionMatrix{"*": {"*"}}, "", http.StatusNotFound, ""},
		{"registry down", middlewareRegistry{defErr: errors.New("db down")}, auth.PermissionMatrix{"*": {"*"}}, "", http.StatusServiceUnavailable, ""},
	}
	for _, tc := range cases {
		svc, err := k8s.NewService(context.Background(), tc.reg, false, nil, k8s.ServiceOptions{})
		if err != nil {
			t.Fatal(err)
		}
		h := &Handler{svc: svc}
		var got cluster.ID
		mw := h.ClusterMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got, _ = cluster.FromContext(r.Context()) }))
		req := httptest.NewRequest(http.MethodGet, "/api/v1/cluster/overview"+tc.query, nil)
		req = req.WithContext(auth.WithPayload(req.Context(), auth.TokenPayload{UserID: "u1", Perms: tc.perms}))
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, req)
		if rec.Code != tc.status || got != tc.ctxID {
			t.Errorf("%s: status %d ctx %q, want %d ctx %q (body %s)", tc.name, rec.Code, got, tc.status, tc.ctxID, rec.Body.String())
		}
	}
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
		{"", http.StatusNotFound, false},        // nothing registered to fall back to
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

// Every request through the middleware answers with the identity its cluster
// calls go out as: the groups the impersonating transport sends, nothing when
// impersonation is off.
func TestClusterMiddlewareAccessHeader(t *testing.T) {
	svc, err := k8s.NewService(context.Background(), middlewareRegistry{}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	p := auth.TokenPayload{UserID: "u1", Email: "a@example.com", Perms: auth.PermissionMatrix{"known": {"resource.*.read"}}, Roles: map[string]string{"known": "Read"}}
	for _, imp := range []bool{true, false} {
		h := &Handler{svc: svc, cfg: config.Config{ImpersonationEnabled: imp}}
		mw := h.ClusterMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		req := httptest.NewRequest(http.MethodGet, "/api/v1/namespaces?cluster=known", nil)
		req = req.WithContext(auth.WithPayload(req.Context(), p))
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, req)
		raw, err := base64.RawURLEncoding.DecodeString(rec.Header().Get(auth.HeaderAccess))
		if err != nil {
			t.Fatalf("impersonation=%v: header %q: %v", imp, rec.Header().Get(auth.HeaderAccess), err)
		}
		var got auth.Access
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
		want := auth.Access{Cluster: "known", Kind: "person", Role: "Read", Impersonation: imp}
		if imp {
			want.User, want.Groups = "a@example.com", []string{auth.GroupAuthenticated, auth.GroupViewer}
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("impersonation=%v: access %+v, want %+v", imp, got, want)
		}
	}
}
