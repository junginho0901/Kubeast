package routes

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
)

func routeSet(routes ...string) map[string]bool {
	set := make(map[string]bool, len(routes))
	for _, route := range routes {
		set[route] = true
	}
	return set
}

// sharedReadRoutes are the reads a crowd repeats and that each cost the cluster or the memory something (handler.Shared):
// the drawers, which an open object's every change reads again, the checks behind their buttons and the reads of a whole
// namespace's or cluster's pods. Each handler reads only the route and the query and writes no audit row.
// TestEveryDescribeRouteSaysWhetherItIsShared holds the describes to this list and notSharedDescribes.
var sharedReadRoutes = routeSet(
	"/api/v1/can-i",
	"/api/v1/overview",

	"/api/v1/namespaces/{namespace}/describe",
	"/api/v1/nodes/{name}/describe",
	"/api/v1/namespaces/{namespace}/pods/{name}/describe",
	"/api/v1/namespaces/{namespace}/deployments/{name}/describe",
	"/api/v1/namespaces/{namespace}/statefulsets/{name}/describe",
	"/api/v1/namespaces/{namespace}/daemonsets/{name}/describe",
	"/api/v1/namespaces/{namespace}/replicasets/{name}/describe",
	"/api/v1/namespaces/{namespace}/jobs/{name}/describe",
	"/api/v1/namespaces/{namespace}/cronjobs/{name}/describe",
	"/api/v1/namespaces/{namespace}/services/{name}/describe",
	"/api/v1/namespaces/{namespace}/ingresses/{name}/describe",
	"/api/v1/ingressclasses/{name}/describe",
	"/api/v1/namespaces/{namespace}/endpoints/{name}/describe",
	"/api/v1/namespaces/{namespace}/endpointslices/{name}/describe",
	"/api/v1/namespaces/{namespace}/networkpolicies/{name}/describe",
	"/api/v1/namespaces/{namespace}/gateways/{name}/describe",
	"/api/v1/gatewayclasses/{name}/describe",
	"/api/v1/namespaces/{namespace}/httproutes/{name}/describe",
	"/api/v1/namespaces/{namespace}/grpcroutes/{name}/describe",
	"/api/v1/namespaces/{namespace}/referencegrants/{name}/describe",
	"/api/v1/namespaces/{namespace}/backendtlspolicies/{name}/describe",
	"/api/v1/namespaces/{namespace}/pvcs/{name}/describe",
	"/api/v1/pvs/{name}/describe",
	"/api/v1/storageclasses/{name}/describe",
	"/api/v1/volumeattachments/{name}/describe",
	"/api/v1/namespaces/{namespace}/configmaps/{name}/describe",
	"/api/v1/namespaces/{namespace}/hpas/{name}/describe",
	"/api/v1/namespaces/{namespace}/vpas/{name}/describe",
	"/api/v1/namespaces/{namespace}/pdbs/{name}/describe",
	"/api/v1/priorityclasses/{name}/describe",
	"/api/v1/runtimeclasses/{name}/describe",
	"/api/v1/namespaces/{namespace}/resourcequotas/{name}/describe",
	"/api/v1/namespaces/{namespace}/limitranges/{name}/describe",
	"/api/v1/mutatingwebhookconfigurations/{name}/describe",
	"/api/v1/validatingwebhookconfigurations/{name}/describe",
	"/api/v1/mutatingadmissionpolicies/{name}/describe",
	"/api/v1/validatingadmissionpolicies/{name}/describe",
	"/api/v1/namespaces/{namespace}/leases/{name}/describe",
	"/api/v1/namespaces/{namespace}/serviceaccounts/{name}/describe",
	"/api/v1/namespaces/{namespace}/roles/{name}/describe",
	"/api/v1/namespaces/{namespace}/rolebindings/{name}/describe",
	"/api/v1/clusterroles/{name}/describe",
	"/api/v1/clusterrolebindings/{name}/describe",
	"/api/v1/crds/{name}/describe",
	"/api/v1/custom-resources/{group}/{version}/{plural}/{namespace}/{name}/describe",
	"/api/v1/deviceclasses/{name}/describe",
	"/api/v1/namespaces/{namespace}/resourceclaims/{name}/describe",
	"/api/v1/namespaces/{namespace}/resourceclaimtemplates/{name}/describe",
	"/api/v1/resourceslices/{name}/describe",

	"/api/v1/custom-resources/{group}/{version}/{plural}",
	"/api/v1/namespaces/{namespace}/limitranges/{name}/violations",
	"/api/v1/namespaces/{namespace}/services/{name}/backend-usage",
	"/api/v1/pods/all",
	"/api/v1/namespaces/{namespace}/pods",
	"/api/v1/namespaces/{namespace}/owned-pods",
	"/api/v1/optimization",
	"/api/v1/gpu/dashboard",
	"/api/v1/issues",
	"/api/v1/resource-graph",
	"/api/v1/namespaces/{namespace}/resource-graph",
	"/api/v1/topology/namespace/{namespace}",
	"/api/v1/topology/service/{namespace}/{service_name}",
	"/api/v1/topology/deployment/{namespace}/{deployment_name}",
	"/api/v1/topology/storage",
	"/api/v1/timeline",
	"/api/v1/namespaces/{namespace}/timeline",
	"/api/v1/namespaces/{namespace}/timeline/{kind}/{name}",
)

// notSharedDescribes write a row for each caller's reveal of a Secret, which one run cannot stand for.
var notSharedDescribes = routeSet(
	"/api/v1/namespaces/{namespace}/secrets/{name}/describe",
	"/api/v1/resources/describe",
)

// sharedReadRouter wraps the GET routes of sharedReadRoutes in handler.Shared as they are registered.
type sharedReadRouter struct {
	chi.Router
	h *handler.Handler
}

func (r sharedReadRouter) Get(pattern string, fn http.HandlerFunc) {
	if sharedReadRoutes[pattern] {
		fn = r.h.Shared(fn)
	}
	r.Router.Get(pattern, fn)
}

// sharingReads is r with the reads of sharedReadRoutes shared.
func sharingReads(r chi.Router, h *handler.Handler) chi.Router {
	return sharedReadRouter{Router: r, h: h}
}
