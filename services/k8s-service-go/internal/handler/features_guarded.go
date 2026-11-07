package handler

import (
	"net/http"
	"slices"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
)

// writeGuardedNamespaces names the guarded namespaces that refuse this caller's writes on the request's cluster, so a
// button follows the features answer a screen already holds instead of asking per row. A grant limited to namespaces
// hears only of its own, and nothing here asks the cluster.
func (h *Handler) writeGuardedNamespaces(r *http.Request) []string {
	refused := []string{}
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		return refused
	}
	id, _ := cluster.FromContext(r.Context())
	scope := payload.Namespaces[string(id)]
	guarded := h.svc.ProtectedNamespaces(r.Context())
	for _, namespace := range []string{guarded.Install, guarded.NodeShell} {
		if namespace == "" || (len(scope) > 0 && !slices.Contains(scope, namespace)) {
			continue
		}
		if guarded.Refusal(payload, string(id), namespace, protectedns.ActWrite) != nil {
			refused = append(refused, namespace)
		}
	}
	return refused
}
