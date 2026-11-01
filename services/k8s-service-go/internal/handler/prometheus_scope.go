package handler

import (
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// promScope is the namespaces the caller's grant on the request's cluster is limited to (none = the whole cluster).
func promScope(r *http.Request) []string {
	id, _ := cluster.FromContext(r.Context())
	payload, _ := auth.FromContext(r.Context())
	return payload.Namespaces[string(id)]
}

// promClusterWide passes a caller whose grant covers the whole cluster. The cluster's Prometheus answers for the
// whole cluster — a query can name any namespace and the store keeps no per-namespace access — so a grant limited
// to namespaces is refused its reads, as the alerts (alerts.go) and the AI's Prometheus tools are. A read refused
// leaves no audit row, as the namespace scope middleware's refusals.
func promClusterWide(w http.ResponseWriter, r *http.Request) bool {
	if ns := promScope(r); len(ns) > 0 {
		response.Error(w, http.StatusForbidden, "the cluster's Prometheus covers the whole cluster; your grant on this cluster is limited to namespaces ("+strings.Join(ns, ", ")+")")
		return false
	}
	return true
}
