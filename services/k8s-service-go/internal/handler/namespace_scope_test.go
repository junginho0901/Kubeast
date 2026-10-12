package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func TestNamespaceScopeMiddleware(t *testing.T) {
	h := &Handler{}
	scoped := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"c": {"resource.*.read"}}, Namespaces: map[string][]string{"c": {"api", "web"}}}
	whole := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"c": {"resource.*.read"}}}
	cases := []struct {
		name    string
		payload auth.TokenPayload
		cluster string
		path    string
		status  int
	}{
		{"own namespace", scoped, "c", "/api/v1/namespaces/web/pods", http.StatusOK},
		{"own namespace, deep path", scoped, "c", "/api/v1/namespaces/api/pods/p1/logs", http.StatusOK},
		{"other namespace", scoped, "c", "/api/v1/namespaces/db/pods", http.StatusForbidden},
		{"namespace object itself", scoped, "c", "/api/v1/namespaces/db", http.StatusForbidden},
		{"not a namespaced path", scoped, "c", "/api/v1/nodes", http.StatusOK},
		{"namespace list", scoped, "c", "/api/v1/namespaces", http.StatusOK},
		{"another cluster unscoped", scoped, "d", "/api/v1/namespaces/db/pods", http.StatusOK},
		{"unscoped grant", whole, "c", "/api/v1/namespaces/db/pods", http.StatusOK},
	}
	for _, tc := range cases {
		next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		ctx := auth.WithPayload(cluster.WithID(req.Context(), cluster.ID(tc.cluster)), tc.payload)
		rec := httptest.NewRecorder()
		h.NamespaceScopeMiddleware(next).ServeHTTP(rec, req.WithContext(ctx))
		if rec.Code != tc.status {
			t.Errorf("%s: status %d, want %d (%s)", tc.name, rec.Code, tc.status, rec.Body.String())
		}
	}
}
