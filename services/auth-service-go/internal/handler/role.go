package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

type RoleHandler struct {
	repo *repository.Repository
}

func NewRoleHandler(repo *repository.Repository) *RoleHandler {
	return &RoleHandler{repo: repo}
}

// ListRoles handles GET /auth/roles (public, for dropdowns)
func (h *RoleHandler) ListRoles(w http.ResponseWriter, r *http.Request) {
	roles, err := h.repo.ListRoles(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
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

	role, err := h.repo.CreateRole(r.Context(), req.Name, req.Description, req.Permissions)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
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

	// System roles: allow permission changes but not name changes
	name := req.Name
	if existing.IsSystem && name != existing.Name {
		response.Error(w, http.StatusBadRequest, "Cannot rename system role")
		return
	}

	role, err := h.repo.UpdateRole(r.Context(), id, name, req.Description, req.Permissions)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
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

	if err := h.repo.DeleteRole(r.Context(), id); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
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
	categories := []map[string]interface{}{
		{"category": "전체", "permissions": []perm{
			{"*", "전체 권한"},
		}},
		{"category": "메뉴", "permissions": []perm{
			{"menu.*", "모든 메뉴"},
			{"menu.dashboard", "대시보드"},
			{"menu.workloads", "워크로드"},
			{"menu.network", "네트워크"},
			{"menu.storage", "스토리지"},
			{"menu.security", "보안"},
			{"menu.cluster", "클러스터"},
			{"menu.gateway", "게이트웨이"},
			{"menu.gpu", "GPU"},
			{"menu.configuration", "설정"},
			{"menu.admin", "관리자"},
		}},
		{"category": "리소스", "permissions": []perm{
			{"resource.*.*", "모든 리소스 전체"},
			{"resource.*.read", "모든 리소스 조회"},
			{"resource.*.create", "모든 리소스 생성"},
			{"resource.*.edit", "모든 리소스 수정"},
			{"resource.*.delete", "모든 리소스 삭제"},
		}},
		{"category": "노드", "permissions": []perm{
			{"resource.node.cordon", "Cordon/Uncordon"},
			{"resource.node.drain", "Drain"},
			{"resource.node.shell", "노드 셸"},
		}},
		{"category": "Pod", "permissions": []perm{
			{"resource.pod.exec", "Pod Exec"},
		}},
		{"category": "워크로드", "permissions": []perm{
			{"resource.workload.restart", "재시작"},
			{"resource.workload.rollback", "롤백"},
			{"resource.cronjob.suspend", "CronJob 일시중지"},
			{"resource.cronjob.trigger", "CronJob 수동실행"},
		}},
		{"category": "Secret", "permissions": []perm{
			{"resource.secret.reveal", "Secret 복호화"},
		}},
		{"category": "AI 도구", "permissions": []perm{
			{"ai.tool.*", "모든 AI 도구"},
			{"ai.tool.k8s_execute_command", "K8s 명령어 실행"},
		}},
		{"category": "관리자", "permissions": []perm{
			{"admin.*", "모든 관리자 기능"},
			{"admin.users.*", "사용자 관리"},
			{"admin.users.create", "사용자 생성"},
			{"admin.users.read", "사용자 조회"},
			{"admin.users.update", "사용자 수정"},
			{"admin.users.delete", "사용자 삭제"},
			{"admin.roles.*", "역할 관리"},
			{"admin.roles.create", "역할 생성"},
			{"admin.roles.update", "역할 수정"},
			{"admin.roles.delete", "역할 삭제"},
			{"admin.organizations.*", "본부/팀 관리"},
			{"admin.organizations.create", "본부/팀 생성"},
			{"admin.organizations.delete", "본부/팀 삭제"},
			{"admin.ai_models.*", "AI 모델 설정"},
		}},
	}
	return categories
}
