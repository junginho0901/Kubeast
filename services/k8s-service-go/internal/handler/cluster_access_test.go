package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// passesTheMiddleware says whether a caller reaches the handler of path on the cluster "known".
func passesTheMiddleware(t *testing.T, perms auth.PermissionMatrix, path string) (bool, int) {
	t.Helper()
	svc, err := k8s.NewService(context.Background(), middlewareRegistry{}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{svc: svc, auditStore: &memAudit{}}
	reached := false
	mw := h.ClusterMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))
	req := httptest.NewRequest(http.MethodGet, path+"?cluster=known", nil)
	req = req.WithContext(auth.WithPayload(req.Context(), auth.TokenPayload{UserID: "u1", Perms: perms}))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)
	return reached, rec.Code
}

func TestAGlobalAdminPageKeyDoesNotOpenAClusterWithoutAGrant(t *testing.T) {
	for _, key := range []string{"admin.audit.read", "admin.users.read", "admin.sessions.read", "admin.clusters.list"} {
		for _, path := range []string{"/api/v1/cluster/overview", "/api/v1/prometheus/query", "/api/v1/gpu/metrics", "/api/v1/namespaces/a/pods"} {
			reached, code := passesTheMiddleware(t, auth.PermissionMatrix{"*": {key}}, path)
			if reached || code != http.StatusForbidden {
				t.Errorf("%s on %s: reached %v, status %d, want 403", key, path, reached, code)
			}
		}
	}
}

func TestTheGlobalAdminAndAGrantStillReachTheCluster(t *testing.T) {
	for name, perms := range map[string]auth.PermissionMatrix{
		"global admin":     {"*": {"*"}},
		"grant":            {"known": {"resource.*.read"}},
		"grant and a page": {"*": {"admin.audit.read"}, "known": {"resource.*.read"}},
	} {
		if reached, code := passesTheMiddleware(t, perms, "/api/v1/cluster/overview"); !reached {
			t.Errorf("%s: status %d", name, code)
		}
	}
}

func TestAnAdminPagesKeyStillOpensWhatThatPageReads(t *testing.T) {
	for _, tc := range []struct {
		key, path string
		reached   bool
	}{
		{"admin.hygiene.read", "/api/v1/hygiene", true},
		{"admin.hygiene.read", "/api/v1/hygiene/history", true},
		{"admin.hygiene.read", "/api/v1/hygiene/snapshot/r1", true},
		{"admin.hygiene.export", "/api/v1/hygiene", true},
		{"admin.hygiene.signoff", "/api/v1/hygiene/signoff", true},
		{"admin.clusters.update", "/api/v1/prometheus/status", true},
		{"admin.clusters.create", "/api/v1/logsearch/status", true},
		{"admin.audit.read", "/api/v1/features", true},
		// the same keys on what their page does not read
		{"admin.audit.read", "/api/v1/hygiene", false},
		{"admin.audit.read", "/api/v1/prometheus/status", false},
		{"admin.hygiene.read", "/api/v1/prometheus/status", false},
		{"admin.hygiene.read", "/api/v1/hygienefoo", false},
		{"admin.clusters.update", "/api/v1/prometheus/query", false},
	} {
		if reached, code := passesTheMiddleware(t, auth.PermissionMatrix{"*": {tc.key}}, tc.path); reached != tc.reached {
			t.Errorf("%s on %s: reached %v (status %d), want %v", tc.key, tc.path, reached, code, tc.reached)
		}
	}
}

func TestNoGlobalKeyOpensNothing(t *testing.T) {
	if reached, code := passesTheMiddleware(t, auth.PermissionMatrix{"other": {"resource.*.read"}}, "/api/v1/features"); reached || code != http.StatusForbidden {
		t.Fatalf("reached %v, status %d", reached, code)
	}
}

// internalRoute calls an internal cluster route as a caller, with {id} set.
func internalRoute(handle http.HandlerFunc, perms auth.PermissionMatrix) int {
	req := httptest.NewRequest(http.MethodPost, "/internal/clusters/c1/x", nil)
	ctx := auth.WithPayload(req.Context(), auth.TokenPayload{UserID: "u1", Perms: perms})
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", "c1")
	req = req.WithContext(context.WithValue(ctx, chi.RouteCtxKey, rc))
	rec := httptest.NewRecorder()
	handle(rec, req)
	return rec.Code
}

func TestAPageKeyDoesNotOpenAClustersKubeconfig(t *testing.T) {
	svc, err := k8s.NewService(context.Background(), middlewareRegistry{}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{svc: svc, auditStore: &memAudit{}}
	if code := internalRoute(h.GetClusterKubeconfig, auth.PermissionMatrix{"*": {"admin.audit.read"}}); code != http.StatusForbidden {
		t.Fatalf("status %d", code)
	}
}

func TestClusterRegistrationStillInvalidatesAndValidates(t *testing.T) {
	svc, err := k8s.NewService(context.Background(), middlewareRegistry{}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{svc: svc, auditStore: &memAudit{}}
	reg := auth.PermissionMatrix{"*": {auth.PermClustersUpdate}}
	if code := internalRoute(h.InvalidateCluster, reg); code != http.StatusNoContent {
		t.Errorf("invalidate as a holder of the registration key: %d", code)
	}
	if code := internalRoute(h.ValidateCluster, reg); code == http.StatusForbidden {
		t.Errorf("validate as a holder of the registration key: %d", code)
	}
	other := auth.PermissionMatrix{"*": {"admin.audit.read"}}
	for name, route := range map[string]http.HandlerFunc{"invalidate": h.InvalidateCluster, "validate": h.ValidateCluster} {
		if code := internalRoute(route, other); code != http.StatusForbidden {
			t.Errorf("%s with an unrelated key: %d", name, code)
		}
	}
}
