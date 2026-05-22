package routes

import (
	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
)

// RegisterSecurity — ServiceAccount, Role, RoleBinding, ClusterRole.
//
// Frontend 가 /cluster/X (gateway 가 /api/v1/X 로 prefix strip) 형식으로 호출.
// ClusterRole 은 cluster-scoped 라 namespace path segment 없음.
func RegisterSecurity(r chi.Router, h *handler.Handler) {
	// ServiceAccounts
	r.Get("/api/v1/serviceaccounts/all", h.GetAllServiceAccounts)
	r.Get("/api/v1/namespaces/{namespace}/serviceaccounts", h.GetServiceAccounts)
	r.Get("/api/v1/namespaces/{namespace}/serviceaccounts/{name}/describe", h.DescribeServiceAccount)
	r.Get("/api/v1/namespaces/{namespace}/serviceaccounts/{name}/yaml", h.GetServiceAccountYAML)
	r.Delete("/api/v1/namespaces/{namespace}/serviceaccounts/{name}", h.DeleteServiceAccount)

	// Roles
	r.Get("/api/v1/roles/all", h.GetAllRoles)
	r.Get("/api/v1/namespaces/{namespace}/roles", h.GetRoles)
	r.Get("/api/v1/namespaces/{namespace}/roles/{name}/describe", h.DescribeRole)
	r.Get("/api/v1/namespaces/{namespace}/roles/{name}/yaml", h.GetRoleYAML)
	r.Delete("/api/v1/namespaces/{namespace}/roles/{name}", h.DeleteRole)

	// RoleBindings
	r.Get("/api/v1/rolebindings/all", h.GetAllRoleBindings)
	r.Get("/api/v1/namespaces/{namespace}/rolebindings", h.GetRoleBindings)
	r.Get("/api/v1/namespaces/{namespace}/rolebindings/{name}/describe", h.DescribeRoleBinding)
	r.Get("/api/v1/namespaces/{namespace}/rolebindings/{name}/yaml", h.GetRoleBindingYAML)
	r.Delete("/api/v1/namespaces/{namespace}/rolebindings/{name}", h.DeleteRoleBinding)

	// ClusterRoles (cluster-scoped)
	r.Get("/api/v1/clusterroles", h.GetClusterRoles)
	r.Get("/api/v1/clusterroles/{name}/describe", h.DescribeClusterRole)
	r.Get("/api/v1/clusterroles/{name}/yaml", h.GetClusterRoleYAML)
	r.Delete("/api/v1/clusterroles/{name}", h.DeleteClusterRole)
}
