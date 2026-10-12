package handler

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// namespacedPath picks the namespace out of /api/v1/namespaces/{namespace}/…
var namespacedPath = regexp.MustCompile(`^/api/v1/namespaces/([^/]+)(?:/|$)`)

// NamespaceScopeMiddleware applies a namespace-scoped grant (the token's "ns"
// claim) to the request's cluster: a namespaced path outside the granted list
// is refused with 403 before any cluster call. Runs after ClusterMiddleware.
// All-namespaces lists, the namespace list and the overview are narrowed in
// the service (k8s/namespace_scope.go); cluster-scoped paths are left to the
// cluster's own RBAC.
func (h *Handler) NamespaceScopeMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, ok := auth.FromContext(r.Context())
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		id, _ := cluster.FromContext(r.Context())
		scope := payload.Namespaces[string(id)]
		if len(scope) == 0 {
			next.ServeHTTP(w, r)
			return
		}
		m := namespacedPath.FindStringSubmatch(r.URL.Path)
		if m == nil {
			next.ServeHTTP(w, r)
			return
		}
		if payload.AllowedIn(string(id), m[1]) {
			next.ServeHTTP(w, r)
			return
		}
		err := errors.New("forbidden: namespace " + m[1] + " is outside your grant on cluster " + string(id) + " (" + strings.Join(scope, ", ") + ")")
		// A write or a terminal is a refused attempt worth a row; reads are not (see denied).
		if r.Method != http.MethodGet || strings.HasSuffix(r.URL.Path, "/ws") {
			_ = h.recordAuditWithPayload(r, "k8s.access.denied", "namespace", m[1], "", err, nil,
				audit.MustJSON(map[string]interface{}{"permission": "namespace scope", "method": r.Method, "path": r.URL.Path, "namespaces": scope}))
		}
		response.Error(w, http.StatusForbidden, err.Error())
	})
}
