package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

type RoleHandler struct {
	repo       *repository.Repository
	auditStore audit.Store
}

func NewRoleHandler(repo *repository.Repository, auditStore audit.Store) *RoleHandler {
	return &RoleHandler{repo: repo, auditStore: auditStore}
}

// samePermissions compares two permission lists as sets.
func samePermissions(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[string]struct{}, len(a))
	for _, p := range a {
		seen[p] = struct{}{}
	}
	for _, p := range b {
		if _, ok := seen[p]; !ok {
			return false
		}
	}
	return true
}

// roleState is the audited shape of a role: what changes when permissions
// are granted or taken away.
func roleState(name, description string, permissions []string) map[string]any {
	if permissions == nil {
		permissions = []string{}
	}
	return map[string]any{"name": name, "description": description, "permissions": permissions}
}

// ListRoles handles GET /auth/roles (public, for dropdowns)
func (h *RoleHandler) ListRoles(w http.ResponseWriter, r *http.Request) {
	roles, err := h.repo.ListRoles(r.Context())
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, roles)
}

// ListPermissions handles GET /auth/permissions (UI checkbox grid)
func (h *RoleHandler) ListPermissions(w http.ResponseWriter, r *http.Request) {
	permissions := allPermissions()
	response.JSON(w, http.StatusOK, permissions)
}

// CreateRole handles POST /auth/admin/roles
func (h *RoleHandler) CreateRole(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.roles.create") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	var req model.CreateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Name == "" {
		response.Error(w, http.StatusBadRequest, "Name required")
		return
	}
	if unknown := unknownPermissions(req.Permissions); len(unknown) > 0 {
		response.Error(w, http.StatusBadRequest, "Unknown permissions: "+strings.Join(unknown, ", "))
		return
	}
	// Ceiling: a role may only carry permissions its creator holds.
	if missing := missingPermissions(payload, req.Permissions, ""); len(missing) > 0 {
		err := ceilingError(missing)
		writeAudit(h.auditStore, r, payload, auditEvent{action: "admin.roles.create", targetType: "role", after: roleState(req.Name, req.Description, req.Permissions), err: err})
		response.Error(w, http.StatusForbidden, err.Error())
		return
	}

	role, err := h.repo.CreateRole(r.Context(), req.Name, req.Description, req.Permissions)
	ev := auditEvent{action: "admin.roles.create", targetType: "role", after: roleState(req.Name, req.Description, req.Permissions), err: err}
	if role != nil {
		ev.targetID = strconv.Itoa(role.ID)
	}
	writeAudit(h.auditStore, r, payload, ev)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusCreated, role)
}

// UpdateRole handles PUT /auth/admin/roles/{id}
func (h *RoleHandler) UpdateRole(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.roles.update") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	id, err := strconv.Atoi(chi.URLParam(r, "id"))
	if err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid ID")
		return
	}

	existing, err := h.repo.GetRoleByID(r.Context(), id)
	if err != nil || existing == nil {
		response.Error(w, http.StatusNotFound, "Role not found")
		return
	}

	var req model.UpdateRolePermissionsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// System roles: the seed (repository.SeedSystemRoles) is the source of
	// truth for their name and permissions; only the description may change.
	name := req.Name
	if existing.IsSystem && name != existing.Name {
		response.Error(w, http.StatusBadRequest, "Cannot rename system role")
		return
	}
	if existing.IsSystem && !samePermissions(existing.Permissions, req.Permissions) {
		err := errors.New("system role permissions are fixed")
		writeAudit(h.auditStore, r, payload, auditEvent{action: "admin.roles.update", targetType: "role", targetID: strconv.Itoa(id),
			before: roleState(existing.Name, existing.Description, existing.Permissions), after: roleState(name, req.Description, req.Permissions), err: err})
		response.Error(w, http.StatusForbidden, "System role permissions are fixed")
		return
	}
	if unknown := unknownPermissions(req.Permissions); len(unknown) > 0 {
		response.Error(w, http.StatusBadRequest, "Unknown permissions: "+strings.Join(unknown, ", "))
		return
	}
	// Ceiling: the role may only carry permissions the editor holds.
	if missing := missingPermissions(payload, req.Permissions, ""); len(missing) > 0 {
		err := ceilingError(missing)
		writeAudit(h.auditStore, r, payload, auditEvent{action: "admin.roles.update", targetType: "role", targetID: strconv.Itoa(id),
			before: roleState(existing.Name, existing.Description, existing.Permissions), after: roleState(name, req.Description, req.Permissions), err: err})
		response.Error(w, http.StatusForbidden, err.Error())
		return
	}

	role, err := h.repo.UpdateRole(r.Context(), id, name, req.Description, req.Permissions)
	writeAudit(h.auditStore, r, payload, auditEvent{
		action: "admin.roles.update", targetType: "role", targetID: strconv.Itoa(id),
		before: roleState(existing.Name, existing.Description, existing.Permissions),
		after:  roleState(name, req.Description, req.Permissions), err: err,
	})
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, role)
}

// DeleteRole handles DELETE /auth/admin/roles/{id}
func (h *RoleHandler) DeleteRole(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.roles.delete") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	id, err := strconv.Atoi(chi.URLParam(r, "id"))
	if err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid ID")
		return
	}

	existing, err := h.repo.GetRoleByID(r.Context(), id)
	if err != nil || existing == nil {
		response.Error(w, http.StatusNotFound, "Role not found")
		return
	}
	if existing.IsSystem {
		response.Error(w, http.StatusBadRequest, "Cannot delete system role")
		return
	}

	err = h.repo.DeleteRole(r.Context(), id)
	writeAudit(h.auditStore, r, payload, auditEvent{
		action: "admin.roles.delete", targetType: "role", targetID: strconv.Itoa(id),
		before: roleState(existing.Name, existing.Description, existing.Permissions), err: err,
	})
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// allPermissions returns the full permission catalog for the UI.
func allPermissions() []map[string]interface{} {
	type perm struct {
		Key         string `json:"key"`
		Description string `json:"description"`
	}
	// Source language is English; the frontend translates by category name /
	// permission key (adminRoles.catalog.* in its locale files).
	categories := []map[string]interface{}{
		{"category": "All", "permissions": []perm{
			{"*", "All permissions"},
		}},
		{"category": "Menu", "permissions": []perm{
			{"menu.*", "All menus"},
			{"menu.dashboard", "Dashboard"},
			{"menu.workloads", "Workloads"},
			{"menu.network", "Network"},
			{"menu.storage", "Storage"},
			{"menu.security", "Security"},
			{"menu.cluster", "Cluster"},
			{"menu.gateway", "Gateway"},
			{"menu.gpu", "GPU"},
			{"menu.helm", "Helm"},
			{"menu.configuration", "Configuration"},
			{"menu.admin", "Admin"},
		}},
		{"category": "Resources", "permissions": []perm{
			{"resource.*.*", "All resources, every action"},
			{"resource.*.read", "All resources: read"},
			{"resource.*.create", "All resources: create"},
			{"resource.*.edit", "All resources: edit"},
			{"resource.*.delete", "All resources: delete"},
		}},
		{"category": "Node", "permissions": []perm{
			{"resource.node.cordon", "Cordon / uncordon"},
			{"resource.node.drain", "Drain"},
			{"resource.node.shell", "Node shell"},
		}},
		{"category": "Pod", "permissions": []perm{
			{"resource.pod.exec", "Pod exec"},
		}},
		{"category": "Workload", "permissions": []perm{
			{"resource.workload.restart", "Restart"},
			{"resource.workload.rollback", "Rollback"},
			{"resource.cronjob.suspend", "Suspend CronJob"},
			{"resource.cronjob.trigger", "Run CronJob now"},
		}},
		{"category": "Secret", "permissions": []perm{
			{"resource.secret.reveal", "Reveal Secret values"},
		}},
		{"category": "Helm", "permissions": []perm{
			{"resource.helm.*", "All Helm actions"},
			{"resource.helm.read", "View releases"},
			{"resource.helm.rollback", "Roll back releases"},
			{"resource.helm.upgrade", "Upgrade releases (edit values)"},
			{"resource.helm.uninstall", "Uninstall releases"},
			{"resource.helm.test", "Run release tests"},
		}},
		{"category": "AI tools", "permissions": []perm{
			{"ai.tool.*", "All AI tools"},
			{"ai.tool.k8s_execute_command", "Run kubectl commands"},
			{"ai.tool.helm_execute", "AI runs Helm commands (including writes)"},
		}},
		{"category": "Admin", "permissions": []perm{
			{"admin.*", "All admin features"},
			{"admin.users.*", "User management"},
			{"admin.users.create", "Create users"},
			{"admin.users.read", "View users"},
			{"admin.users.update", "Update users"},
			{"admin.users.delete", "Delete users"},
			{"admin.roles.*", "Role management"},
			{"admin.roles.create", "Create roles"},
			{"admin.roles.update", "Update roles"},
			{"admin.roles.delete", "Delete roles"},
			{"admin.organizations.*", "Team management"},
			{"admin.organizations.create", "Create teams"},
			{"admin.organizations.delete", "Delete teams"},
			{"admin.ai_models.*", "AI model settings"},
			{"admin.audit.read", "View audit log"},
			{"admin.audit.export", "Export audit log (CSV)"},
		}},
	}
	return categories
}
