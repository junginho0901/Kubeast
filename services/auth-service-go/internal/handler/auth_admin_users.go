package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// AdminBulkUpdateRole handles PATCH /auth/admin/users/bulk-role
func (h *AuthHandler) AdminBulkUpdateRole(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.users.update") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	var req model.BulkUpdateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate role_id exists
	targetRole, err := h.repo.GetRoleByID(r.Context(), req.RoleID)
	if err != nil || targetRole == nil {
		response.Error(w, http.StatusBadRequest, "Invalid role_id")
		return
	}
	if len(req.UserIDs) == 0 {
		response.Error(w, http.StatusBadRequest, "No user IDs provided")
		return
	}

	updated := make([]model.UserResponse, 0, len(req.UserIDs))
	for _, uid := range req.UserIDs {
		if uid == payload.UserID {
			continue // skip changing own role
		}
		if err := h.repo.UpdateUserRole(r.Context(), uid, req.RoleID); err != nil {
			continue
		}
		u, _ := h.repo.GetUserByID(r.Context(), uid)
		if u != nil {
			updated = append(updated, u.ToResponse())
		}
	}

	response.JSON(w, http.StatusOK, updated)
}

// AdminBulkCreateUsers handles POST /auth/admin/users/bulk
func (h *AuthHandler) AdminBulkCreateUsers(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.users.create") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	var req model.BulkCreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if len(req.Users) == 0 {
		response.Error(w, http.StatusBadRequest, "No users provided")
		return
	}
	if len(req.Users) > 100 {
		response.Error(w, http.StatusBadRequest, "Maximum 100 users per request")
		return
	}

	var created []model.UserResponse
	var bulkErrors []model.BulkError

	for _, u := range req.Users {
		if u.Name == "" || !strings.Contains(u.Email, "@") || u.Password == "" {
			bulkErrors = append(bulkErrors, model.BulkError{Email: u.Email, Message: "Missing required fields (name, email, password)"})
			continue
		}

		// Validate role_id
		roleID := u.RoleID
		if roleID == 0 {
			readRole, _ := h.repo.GetRoleByName(r.Context(), "Read")
			if readRole != nil {
				roleID = readRole.ID
			}
		}
		targetRole, err := h.repo.GetRoleByID(r.Context(), roleID)
		if err != nil || targetRole == nil {
			bulkErrors = append(bulkErrors, model.BulkError{Email: u.Email, Message: "Invalid role_id"})
			continue
		}

		if u.Team != nil && strings.TrimSpace(*u.Team) != "" {
			if ok, _ := h.repo.OrganizationExists(r.Context(), "team", strings.TrimSpace(*u.Team)); !ok {
				bulkErrors = append(bulkErrors, model.BulkError{Email: u.Email, Message: "Invalid Team: " + *u.Team})
				continue
			}
		}

		existing, _ := h.repo.GetUserByEmail(r.Context(), u.Email)
		if existing != nil {
			bulkErrors = append(bulkErrors, model.BulkError{Email: u.Email, Message: "Email already exists"})
			continue
		}

		hash, err := security.HashPassword(u.Password, h.cfg.PasswordHashIterations)
		if err != nil {
			bulkErrors = append(bulkErrors, model.BulkError{Email: u.Email, Message: "Failed to hash password"})
			continue
		}

		now := time.Now().UTC()
		user := &model.User{
			ID:           uuid.New().String(),
			Name:         u.Name,
			Email:        u.Email,
			Team:         u.Team,
			RoleID:       roleID,
			RoleName:     targetRole.Name,
			PasswordHash: hash,
			CreatedAt:    now,
			UpdatedAt:    now,
		}

		if err := h.repo.CreateUser(r.Context(), user); err != nil {
			bulkErrors = append(bulkErrors, model.BulkError{Email: u.Email, Message: err.Error()})
			continue
		}

		created = append(created, user.ToResponse())
	}

	response.JSON(w, http.StatusOK, model.BulkCreateUserResponse{
		Created: created,
		Errors:  bulkErrors,
	})
}

// AdminCreateUser handles POST /auth/admin/users
func (h *AuthHandler) AdminCreateUser(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.users.create") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	var req model.AdminCreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Name == "" {
		response.Error(w, http.StatusBadRequest, "Name required")
		return
	}
	if !strings.Contains(req.Email, "@") {
		response.Error(w, http.StatusBadRequest, "Invalid email")
		return
	}
	if req.Password == "" {
		response.Error(w, http.StatusBadRequest, "Password required")
		return
	}

	// Validate role_id
	roleID := req.RoleID
	if roleID == 0 {
		readRole, _ := h.repo.GetRoleByName(r.Context(), "Read")
		if readRole != nil {
			roleID = readRole.ID
		}
	}
	targetRole, err := h.repo.GetRoleByID(r.Context(), roleID)
	if err != nil || targetRole == nil {
		response.Error(w, http.StatusBadRequest, "Invalid role_id")
		return
	}

	// Validate Team
	if req.Team != nil && strings.TrimSpace(*req.Team) != "" {
		if ok, _ := h.repo.OrganizationExists(r.Context(), "team", strings.TrimSpace(*req.Team)); !ok {
			response.Error(w, http.StatusBadRequest, "Invalid Team value")
			return
		}
	}

	existing, _ := h.repo.GetUserByEmail(r.Context(), req.Email)
	if existing != nil {
		response.Error(w, http.StatusConflict, "Email already exists")
		return
	}

	hash, err := security.HashPassword(req.Password, h.cfg.PasswordHashIterations)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to hash password")
		return
	}

	now := time.Now().UTC()
	user := &model.User{
		ID:           uuid.New().String(),
		Name:         req.Name,
		Email:        req.Email,
		Team:         req.Team,
		RoleID:       roleID,
		RoleName:     targetRole.Name,
		PasswordHash: hash,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	if err := h.repo.CreateUser(r.Context(), user); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	actor, _ := h.repo.GetUserByID(r.Context(), payload.UserID)
	var actorEmail *string
	if actor != nil {
		actorEmail = &actor.Email
	}
	after := jsonRaw(map[string]string{"email": user.Email, "role": targetRole.Name, "name": user.Name})
	h.writeAuditLog(r, "user.create", &payload.UserID, actorEmail, &user.ID, &user.Email, nil, after)

	response.JSON(w, http.StatusCreated, user.ToResponse())
}

// AdminListUsers handles GET /auth/admin/users
func (h *AuthHandler) AdminListUsers(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.users.read") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	limit := queryInt(r, "limit", 100)
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	offset := queryInt(r, "offset", 0)
	if offset < 0 {
		offset = 0
	}

	users, err := h.repo.ListUsers(r.Context(), limit, offset)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	result := make([]model.UserResponse, len(users))
	for i, u := range users {
		result[i] = u.ToResponse()
	}
	response.JSON(w, http.StatusOK, result)
}

// AdminUpdateUser handles PATCH /auth/admin/users/{user_id}
func (h *AuthHandler) AdminUpdateUser(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.users.update") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	userID := chi.URLParam(r, "user_id")

	var req model.AdminUpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	target, err := h.repo.GetUserByID(r.Context(), userID)
	if err != nil || target == nil {
		response.Error(w, http.StatusNotFound, "User not found")
		return
	}

	// Validate name
	if req.Name != nil {
		trimmed := strings.TrimSpace(*req.Name)
		if trimmed == "" {
			response.Error(w, http.StatusBadRequest, "Name cannot be empty")
			return
		}
		req.Name = &trimmed
	}

	// Validate Team
	if req.Team != nil {
		trimmed := strings.TrimSpace(*req.Team)
		if trimmed != "" {
			if ok, _ := h.repo.OrganizationExists(r.Context(), "team", trimmed); !ok {
				response.Error(w, http.StatusBadRequest, "Invalid Team value")
				return
			}
		}
		req.Team = &trimmed
	}

	// Validate role_id (if provided)
	var newRoleName string
	oldRoleName := target.RoleName
	if req.RoleID != nil {
		targetRole, err := h.repo.GetRoleByID(r.Context(), *req.RoleID)
		if err != nil || targetRole == nil {
			response.Error(w, http.StatusBadRequest, "Invalid role_id")
			return
		}
		newRoleName = targetRole.Name
	}

	// Apply profile updates (name/team)
	if req.Name != nil || req.Team != nil {
		if err := h.repo.UpdateUserProfile(r.Context(), userID, req.Name, req.Team); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	// Apply role update
	if req.RoleID != nil {
		if err := h.repo.UpdateUserRole(r.Context(), userID, *req.RoleID); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	// Audit
	beforeMap := map[string]interface{}{
		"name": target.Name,
		"team": derefStr(target.Team),
		"role": oldRoleName,
	}
	afterMap := map[string]interface{}{
		"name": target.Name,
		"team": derefStr(target.Team),
		"role": oldRoleName,
	}
	if req.Name != nil {
		afterMap["name"] = *req.Name
	}
	if req.Team != nil {
		afterMap["team"] = *req.Team
	}
	if req.RoleID != nil {
		afterMap["role"] = newRoleName
	}
	before := jsonRaw(beforeMap)
	after := jsonRaw(afterMap)
	actor, _ := h.repo.GetUserByID(r.Context(), payload.UserID)
	var actorEmail *string
	if actor != nil {
		actorEmail = &actor.Email
	}
	action := "user.update"
	if req.RoleID != nil && req.Name == nil && req.Team == nil {
		action = "user.role.update"
	}
	h.writeAuditLog(r, action, &payload.UserID, actorEmail, &userID, &target.Email, before, after)

	updated, _ := h.repo.GetUserByID(r.Context(), userID)
	if updated == nil {
		updated = target
	}
	response.JSON(w, http.StatusOK, updated.ToResponse())
}

// AdminResetPassword handles POST /auth/admin/users/{user_id}/reset-password
//
// 1회용 랜덤 비밀번호를 생성하여 사용자의 PasswordHash 를 갱신하고,
// 평문 비밀번호를 응답에 포함시켜 관리자가 사용자에게 전달할 수 있게 합니다.
// 평문은 DB 에 저장되지 않으며 응답 한 번에만 노출됩니다.
func (h *AuthHandler) AdminResetPassword(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.users.update") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	userID := chi.URLParam(r, "user_id")
	target, err := h.repo.GetUserByID(r.Context(), userID)
	if err != nil || target == nil {
		response.Error(w, http.StatusNotFound, "User not found")
		return
	}

	tempPassword, err := security.GenerateRandomPassword(12)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to generate password")
		return
	}

	newHash, err := security.HashPassword(tempPassword, h.cfg.PasswordHashIterations)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to hash password")
		return
	}

	if err := h.repo.UpdateUserPassword(r.Context(), userID, newHash); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	actor, _ := h.repo.GetUserByID(r.Context(), payload.UserID)
	var actorEmail *string
	if actor != nil {
		actorEmail = &actor.Email
	}
	h.writeAuditLog(r, "user.password.reset", &payload.UserID, actorEmail, &userID, &target.Email, nil, nil)

	updated, _ := h.repo.GetUserByID(r.Context(), userID)
	if updated == nil {
		updated = target
	}
	response.JSON(w, http.StatusOK, model.AdminResetPasswordResponse{
		UserResponse:      updated.ToResponse(),
		TemporaryPassword: tempPassword,
	})
}

// AdminDeleteUser handles DELETE /auth/admin/users/{user_id}
func (h *AuthHandler) AdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.users.delete") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	userID := chi.URLParam(r, "user_id")
	if userID == payload.UserID {
		response.Error(w, http.StatusBadRequest, "Cannot delete yourself")
		return
	}

	target, err := h.repo.GetUserByID(r.Context(), userID)
	if err != nil || target == nil {
		response.Error(w, http.StatusNotFound, "User not found")
		return
	}

	if err := h.repo.DeleteUser(r.Context(), userID); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	before := jsonRaw(map[string]string{"role": target.RoleName, "email": target.Email, "name": target.Name})
	after := jsonRaw(map[string]bool{"deleted": true})
	actor, _ := h.repo.GetUserByID(r.Context(), payload.UserID)
	var actorEmail *string
	if actor != nil {
		actorEmail = &actor.Email
	}
	h.writeAuditLog(r, "user.delete", &payload.UserID, actorEmail, &userID, &target.Email, before, after)

	w.WriteHeader(http.StatusNoContent)
}
