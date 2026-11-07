package handler

import (
	"errors"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// A global admin.* key opens a page, not a cluster: only the routes below, which that page reads for a cluster its
// holder need not have a grant on. Their handlers check the key themselves where the answer is the cluster's data.
var globalKeyRoutes = []struct {
	path   string
	prefix bool
	// perms is who the route opens to; none = any global key (the sidebar of every admin page reads it).
	perms []string
}{
	{path: "/api/v1/features"},
	{path: "/api/v1/hygiene", prefix: true, perms: []string{"admin.hygiene.read", "admin.hygiene.export", "admin.hygiene.signoff"}},
	{path: "/api/v1/prometheus/status", perms: []string{auth.PermClustersCreate, auth.PermClustersUpdate}},
	{path: "/api/v1/logsearch/status", perms: []string{auth.PermClustersCreate, auth.PermClustersUpdate}},
}

// globalKeyOpens reports whether the caller's global keys open this route on a cluster it has no grant on.
func globalKeyOpens(p auth.TokenPayload, path string) bool {
	if len(p.Perms["*"]) == 0 {
		return false
	}
	for _, route := range globalKeyRoutes {
		if path != route.path && !(route.prefix && strings.HasPrefix(path, route.path+"/")) {
			continue
		}
		if len(route.perms) == 0 {
			return true
		}
		for _, perm := range route.perms {
			if p.HasPermission(perm) {
				return true
			}
		}
	}
	return false
}

// holdsClusterRegistration: auth-service forwards the caller of a cluster registration, rotation or test to the
// internal routes, for a cluster that caller need not have a grant on.
func holdsClusterRegistration(p auth.TokenPayload) bool {
	return p.HasPermission(auth.PermClustersCreate) || p.HasPermission(auth.PermClustersUpdate)
}

// storeStatusFor is a metrics or log store's status for this caller: whoever registers clusters reads its address and
// why it failed in the cluster's edit window; anyone else who may ask reads whether it answers.
func storeStatusFor(p auth.TokenPayload, status map[string]interface{}) map[string]interface{} {
	if holdsClusterRegistration(p) {
		return status
	}
	delete(status, "endpoint")
	if msg, ok := status["message"].(string); ok {
		status["message"] = response.Public(errors.New(msg))
	}
	return status
}
