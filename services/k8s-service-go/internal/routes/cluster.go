package routes

import (
	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
)

// RegisterCluster — cluster-scoped overview, namespaces, nodes, events,
// resource graph / dependency graph, timeline, topology.
func RegisterCluster(r chi.Router, h *handler.Handler) {
	// Overview & cluster
	r.Get("/api/v1/overview", h.GetOverview)
	r.Get("/api/v1/api-resources", h.GetAPIResources)
	r.Get("/api/v1/cluster-config", h.GetClusterConfig)
	r.Get("/api/v1/componentstatuses", h.GetComponentStatuses)

	// Cluster feature flags (used by frontend to opt out of e.g. Prometheus).
	r.Get("/api/v1/features", h.GetClusterFeatures)

	// Namespaces
	r.Get("/api/v1/namespaces", h.GetNamespaces)
	r.Post("/api/v1/namespaces", h.CreateNamespace)
	r.Get("/api/v1/namespaces/{namespace}/describe", h.DescribeNamespace)
	r.Get("/api/v1/namespaces/{namespace}/yaml", h.GetNamespaceYAML)
	r.Post("/api/v1/namespaces/{namespace}/yaml/apply", h.ApplyNamespaceYAML)
	r.Delete("/api/v1/namespaces/{namespace}", h.DeleteNamespace)
	r.Get("/api/v1/namespaces/{namespace}/resource-quotas", h.GetNamespaceResourceQuotas)
	r.Get("/api/v1/namespaces/{namespace}/limit-ranges", h.GetNamespaceLimitRanges)
	r.Get("/api/v1/namespaces/{namespace}/owned-pods", h.GetNamespaceOwnedPods)

	// Nodes
	r.Get("/api/v1/nodes", h.GetNodes)
	r.Get("/api/v1/nodes/{name}/describe", h.DescribeNode)
	r.Get("/api/v1/nodes/{name}/yaml", h.GetNodeYAML)
	r.Get("/api/v1/nodes/{name}/pods", h.GetNodePods)
	r.Get("/api/v1/nodes/{name}/events", h.GetNodeEvents)
	r.Delete("/api/v1/nodes/{name}", h.DeleteNode)
	r.Post("/api/v1/nodes/{name}/yaml/apply", h.ApplyNodeYAML)
	r.Post("/api/v1/nodes/{name}/cordon", h.CordonNode)
	r.Post("/api/v1/nodes/{name}/uncordon", h.UncordonNode)
	r.Post("/api/v1/nodes/{name}/drain", h.DrainNode)
	r.Get("/api/v1/nodes/{name}/drain/status", h.DrainNodeStatus)
	r.Get("/api/v1/nodes/{name}/debug-shell/ws", h.NodeDebugShellWS)

	// Events
	r.Get("/api/v1/events", h.GetEvents)
	r.Get("/api/v1/namespaces/{namespace}/events", h.GetNamespaceEvents)

	// Resource Graph (upgraded)
	r.Get("/api/v1/resource-graph", h.GetResourceGraph)
	r.Get("/api/v1/namespaces/{namespace}/resource-graph", h.GetNamespaceResourceGraph)

	// Timeline (nginx rewrites /api/v1/cluster/namespaces/* → /api/v1/namespaces/*)
	r.Get("/api/v1/namespaces/{namespace}/timeline", h.GetNamespaceTimeline)
	r.Get("/api/v1/namespaces/{namespace}/timeline/{kind}/{name}", h.GetResourceTimeline)

	// Topology
	r.Get("/api/v1/topology/namespace/{namespace}", h.GetNamespaceTopology)
	r.Get("/api/v1/topology/service/{namespace}/{service_name}", h.GetServiceTopology)
	r.Get("/api/v1/topology/deployment/{namespace}/{deployment_name}", h.GetDeploymentTopology)
	r.Get("/api/v1/topology/storage", h.GetStorageTopology)
}
