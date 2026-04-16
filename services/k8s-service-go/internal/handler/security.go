package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// --- ServiceAccounts ---

// GetAllServiceAccounts handles GET /api/v1/serviceaccounts/all.
func (h *Handler) GetAllServiceAccounts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllServiceAccounts(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetServiceAccounts handles GET /api/v1/namespaces/{namespace}/serviceaccounts.
func (h *Handler) GetServiceAccounts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetServiceAccounts(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeServiceAccount handles GET /api/v1/namespaces/{namespace}/serviceaccounts/{name}/describe.
func (h *Handler) DescribeServiceAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeServiceAccount(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetServiceAccountYAML handles GET /api/v1/namespaces/{namespace}/serviceaccounts/{name}/yaml.
func (h *Handler) GetServiceAccountYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "serviceaccounts", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteServiceAccount handles DELETE /api/v1/namespaces/{namespace}/serviceaccounts/{name}.
func (h *Handler) DeleteServiceAccount(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.serviceaccount.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteServiceAccount(ctx, namespace, name)
	h.recordAudit(r, "k8s.serviceaccount.delete", "serviceaccount", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- Roles ---

// GetAllRoles handles GET /api/v1/roles/all.
func (h *Handler) GetAllRoles(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllRoles(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetRoles handles GET /api/v1/namespaces/{namespace}/roles.
func (h *Handler) GetRoles(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetRoles(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeRole handles GET /api/v1/namespaces/{namespace}/roles/{name}/describe.
func (h *Handler) DescribeRole(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeRole(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetRoleYAML handles GET /api/v1/namespaces/{namespace}/roles/{name}/yaml.
func (h *Handler) GetRoleYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "roles", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteRole handles DELETE /api/v1/namespaces/{namespace}/roles/{name}.
func (h *Handler) DeleteRole(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.role.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteRole(ctx, namespace, name)
	h.recordAudit(r, "k8s.role.delete", "role", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- RoleBindings ---

// GetAllRoleBindings handles GET /api/v1/rolebindings/all.
func (h *Handler) GetAllRoleBindings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllRoleBindings(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetRoleBindings handles GET /api/v1/namespaces/{namespace}/rolebindings.
func (h *Handler) GetRoleBindings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetRoleBindings(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeRoleBinding handles GET /api/v1/namespaces/{namespace}/rolebindings/{name}/describe.
func (h *Handler) DescribeRoleBinding(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeRoleBinding(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetRoleBindingYAML handles GET /api/v1/namespaces/{namespace}/rolebindings/{name}/yaml.
func (h *Handler) GetRoleBindingYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "rolebindings", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteRoleBinding handles DELETE /api/v1/namespaces/{namespace}/rolebindings/{name}.
func (h *Handler) DeleteRoleBinding(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.rolebinding.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteRoleBinding(ctx, namespace, name)
	h.recordAudit(r, "k8s.rolebinding.delete", "rolebinding", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
