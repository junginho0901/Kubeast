package handler

import (
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// readsNoObject are the GET routes with no object in their answer: the kinds a cluster serves, its version, the feature
// switches, what the caller may do. The sockets ask per subscription (ws.Multiplexer).
var readsNoObject = map[string]bool{
	"/api/v1/api-resources":     true,
	"/api/v1/can-i":             true,
	"/api/v1/cluster-config":    true,
	"/api/v1/current":           true,
	"/api/v1/features":          true,
	"/api/v1/hygiene/config":    true,
	"/api/v1/logsearch/status":  true,
	"/api/v1/prometheus/status": true,
	"/api/v1/ws":                true,
	"/api/v1/wsMultiplexer":     true,
}

// readsAskTheirOwn are the GET routes whose handlers ask a permission of their own, which the gate leaves to them.
// resource.objects.read opens none of these: it is what a custom role from before the gate holds, and that role does not
// read them today.
var readsAskTheirOwn = map[string]string{
	"/api/v1/alertstore/alerts":           "resource.pod.read",
	"/api/v1/alertstore/silences":         "resource.pod.read",
	"/api/v1/alertstore/silences/preview": "resource.pod.read",

	"/api/v1/cost":        "resource.cost.read",
	"/api/v1/cost/status": "resource.cost.read",

	"/api/v1/helm/releases":                                                   "resource.helm.read",
	"/api/v1/helm/releases/stream":                                            "resource.helm.read",
	"/api/v1/helm/releases/{namespace}/{name}":                                "resource.helm.read",
	"/api/v1/helm/releases/{namespace}/{name}/history":                        "resource.helm.read",
	"/api/v1/helm/releases/{namespace}/{name}/images":                         "resource.helm.read",
	"/api/v1/helm/releases/{namespace}/{name}/resources":                      "resource.helm.read",
	"/api/v1/helm/releases/{namespace}/{name}/revisions/{revision}/{section}": "resource.helm.read",
	"/api/v1/helm/releases/{namespace}/{name}/{section}":                      "resource.helm.read",

	"/api/v1/hygiene":               "resource.hygiene.scan",
	"/api/v1/hygiene/history":       "resource.hygiene.scan",
	"/api/v1/hygiene/snapshot/{id}": "resource.hygiene.scan",

	"/api/v1/logsearch":                                 "resource.pod.read",
	"/api/v1/logsearch/labels":                          "resource.pod.read",
	"/api/v1/logsearch/logql":                           "resource.pod.read",
	"/api/v1/logsearch/patterns":                        "resource.pod.read",
	"/api/v1/logsearch/query":                           "resource.pod.read",
	"/api/v1/namespaces/{namespace}/logsearch":          "resource.pod.read",
	"/api/v1/namespaces/{namespace}/logsearch/labels":   "resource.pod.read",
	"/api/v1/namespaces/{namespace}/logsearch/logql":    "resource.pod.read",
	"/api/v1/namespaces/{namespace}/logsearch/patterns": "resource.pod.read",
	"/api/v1/namespaces/{namespace}/logsearch/query":    "resource.pod.read",

	"/api/v1/namespaces/{namespace}/pods/{name}/logs":        "resource.pod.read",
	"/api/v1/namespaces/{namespace}/pods/{name}/logs/stream": "resource.pod.read",

	"/api/v1/namespaces/{namespace}/pods/{name}/logfiles":         "resource.pod.logfile",
	"/api/v1/namespaces/{namespace}/pods/{name}/logfiles/content": "resource.pod.logfile",
	"/api/v1/namespaces/{namespace}/pods/{name}/logfiles/stream":  "resource.pod.logfile",

	"/api/v1/namespaces/{namespace}/pods/{name}/exec/ws": "resource.pod.exec",
	"/api/v1/nodes/{name}/debug-shell/ws":                "resource.node.shell",
	"/api/v1/nodes/{name}/drain/status":                  "resource.node.drain",

	"/api/v1/namespaces/{namespace}/networkdrops":    "resource.networkflow.read",
	"/api/v1/namespaces/{namespace}/networkflows":    "resource.networkflow.read",
	"/api/v1/namespaces/{namespace}/networktopflows": "resource.networkflow.read",
	"/api/v1/networktraffic":                         "resource.networkflow.read",

	"/api/v1/namespaces/{namespace}/networkpolicies/effective": "resource.networkpolicy.read",
	"/api/v1/networkpolicies/check":                            "resource.networkpolicy.read",

	"/api/v1/namespaces/{namespace}/policyreports/resource": "resource.policyreport.read",
	"/api/v1/policyreports/resource":                        "resource.policyreport.read",
	"/api/v1/policyreports/results":                         "resource.policyreport.read",
	"/api/v1/policyreports/status":                          "resource.policyreport.read",
	"/api/v1/policyreports/summary":                         "resource.policyreport.read",
}

// ReadPermissionFor is what a route asks before it reads: nothing for a write, which asks in its handler, or a read of
// no object; own says its handler asks. Anything else is a list or detail and asks resource.objects.read, a route nobody
// wrote down too. TestEveryReadRouteSaysWhatItAsks holds the routes to this.
func ReadPermissionFor(method, pattern string) (permission string, own bool) {
	if method != http.MethodGet || readsNoObject[pattern] {
		return "", false
	}
	if permission, listed := readsAskTheirOwn[pattern]; listed {
		return permission, true
	}
	return auth.PermObjectsRead, false
}

// ReadGateMiddleware holds a list or detail to the role before anything reads for it. It answers from the permissions in
// the token, with no call to the cluster or the database, and a refused read leaves no row (denied). Runs after
// ClusterMiddleware, in an inline group so the route is already matched.
func (h *Handler) ReadGateMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if permission, own := ReadPermissionFor(r.Method, routePattern(r)); permission != "" && !own {
			if err := h.requirePermissionForCluster(r, permission); err != nil {
				response.Error(w, http.StatusForbidden, err.Error())
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
