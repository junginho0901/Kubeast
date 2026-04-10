package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/junginho0901/kube-assistant/services/auth-service-go/internal/config"
	"github.com/junginho0901/kube-assistant/services/auth-service-go/internal/model"
	"github.com/junginho0901/kube-assistant/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kube-assistant/services/auth-service-go/internal/security"
	"github.com/junginho0901/kube-assistant/services/pkg/auth"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

type AuthHandler struct {
	repo       *repository.Repository
	jwtMgr     *security.JWTManager
	cfg        config.Config
}

func NewAuthHandler(repo *repository.Repository, jwtMgr *security.JWTManager, cfg config.Config) *AuthHandler {
	return &AuthHandler{repo: repo, jwtMgr: jwtMgr, cfg: cfg}
}

// Register handles POST /auth/register
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req model.RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
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

	// Validate HQ/Team against organizations if provided
	if req.HQ != nil && strings.TrimSpace(*req.HQ) != "" {
		if ok, _ := h.repo.OrganizationExists(r.Context(), "hq", strings.TrimSpace(*req.HQ)); !ok {
			response.Error(w, http.StatusBadRequest, "Invalid HQ value")
			return
		}
	}
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

	pendingRole, err := h.repo.GetRoleByName(r.Context(), "Pending")
	if err != nil || pendingRole == nil {
		response.Error(w, http.StatusInternalServerError, "Failed to resolve pending role")
		return
	}

	now := time.Now().UTC()
	user := &model.User{
		ID:           uuid.New().String(),
		Name:         req.Name,
		Email:        req.Email,
		HQ:           req.HQ,
		Team:         req.Team,
		RoleID:       pendingRole.ID,
		RoleName:     pendingRole.Name,
		PasswordHash: hash,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	if err := h.repo.CreateUser(r.Context(), user); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	response.JSON(w, http.StatusOK, user.ToResponse())
}

// Login handles POST /auth/login
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req model.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Email == "" {
		response.Error(w, http.StatusBadRequest, "Email required")
		return
	}

	user, err := h.repo.GetUserByEmail(r.Context(), req.Email)
	if err != nil || user == nil {
		response.Error(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	if !security.VerifyPassword(req.Password, user.PasswordHash) {
		response.Error(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	permissions, err := h.repo.GetPermissionsByRoleID(r.Context(), user.RoleID)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to load permissions")
		return
	}

	token, err := h.jwtMgr.CreateToken(user.ID, user.RoleName, permissions)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to create token")
		return
	}

	// Set HttpOnly cookie
	secure := r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name:     h.cfg.AuthCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   h.cfg.JWTExpiresMinutes * 60,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})

	response.JSON(w, http.StatusOK, model.LoginResponse{
		AccessToken: token,
		TokenType:   "bearer",
		User:        user.ToResponseWithPermissions(permissions),
	})
}

// Logout handles POST /auth/logout
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     h.cfg.AuthCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
	})
	response.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// JWKS handles GET /auth/jwks.json and /auth/.well-known/jwks.json
func (h *AuthHandler) JWKS(w http.ResponseWriter, r *http.Request) {
	response.JSON(w, http.StatusOK, h.jwtMgr.JWKS())
}

// Me handles GET /auth/me
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	user, err := h.repo.GetUserByID(r.Context(), payload.UserID)
	if err != nil || user == nil {
		response.Error(w, http.StatusUnauthorized, "User not found")
		return
	}

	permissions, _ := h.repo.GetPermissionsByRoleID(r.Context(), user.RoleID)
	response.JSON(w, http.StatusOK, user.ToResponseWithPermissions(permissions))
}

// ChangePassword handles POST /auth/change-password
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	var req model.ChangePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.CurrentPassword == "" {
		response.Error(w, http.StatusBadRequest, "Current password required")
		return
	}
	if len(req.NewPassword) < 4 {
		response.Error(w, http.StatusBadRequest, "New password must be at least 4 characters")
		return
	}

	user, err := h.repo.GetUserByID(r.Context(), payload.UserID)
	if err != nil || user == nil {
		response.Error(w, http.StatusUnauthorized, "User not found")
		return
	}

	if !security.VerifyPassword(req.CurrentPassword, user.PasswordHash) {
		response.Error(w, http.StatusUnauthorized, "Invalid current password")
		return
	}

	newHash, err := security.HashPassword(req.NewPassword, h.cfg.PasswordHashIterations)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to hash password")
		return
	}

	if err := h.repo.UpdateUserPassword(r.Context(), user.ID, newHash); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Audit log
	h.writeAuditLog(r, "user.password.change", &payload.UserID, &user.Email, &user.ID, &user.Email, nil, nil)

	updated, _ := h.repo.GetUserByID(r.Context(), user.ID)
	if updated == nil {
		updated = user
	}
	response.JSON(w, http.StatusOK, updated.ToResponse())
}

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

		if u.HQ != nil && strings.TrimSpace(*u.HQ) != "" {
			if ok, _ := h.repo.OrganizationExists(r.Context(), "hq", strings.TrimSpace(*u.HQ)); !ok {
				bulkErrors = append(bulkErrors, model.BulkError{Email: u.Email, Message: "Invalid HQ: " + *u.HQ})
				continue
			}
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
			HQ:           u.HQ,
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

	// Validate HQ/Team
	if req.HQ != nil && strings.TrimSpace(*req.HQ) != "" {
		if ok, _ := h.repo.OrganizationExists(r.Context(), "hq", strings.TrimSpace(*req.HQ)); !ok {
			response.Error(w, http.StatusBadRequest, "Invalid HQ value")
			return
		}
	}
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
		HQ:           req.HQ,
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
	if limit < 1 { limit = 1 }
	if limit > 200 { limit = 200 }
	offset := queryInt(r, "offset", 0)
	if offset < 0 { offset = 0 }

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

	// Validate HQ
	if req.HQ != nil {
		trimmed := strings.TrimSpace(*req.HQ)
		if trimmed != "" {
			if ok, _ := h.repo.OrganizationExists(r.Context(), "hq", trimmed); !ok {
				response.Error(w, http.StatusBadRequest, "Invalid HQ value")
				return
			}
		}
		req.HQ = &trimmed
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

	// Apply profile updates (name/hq/team)
	if req.Name != nil || req.HQ != nil || req.Team != nil {
		if err := h.repo.UpdateUserProfile(r.Context(), userID, req.Name, req.HQ, req.Team); err != nil {
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
		"hq":   derefStr(target.HQ),
		"team": derefStr(target.Team),
		"role": oldRoleName,
	}
	afterMap := map[string]interface{}{
		"name": target.Name,
		"hq":   derefStr(target.HQ),
		"team": derefStr(target.Team),
		"role": oldRoleName,
	}
	if req.Name != nil {
		afterMap["name"] = *req.Name
	}
	if req.HQ != nil {
		afterMap["hq"] = *req.HQ
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
	if req.RoleID != nil && req.Name == nil && req.HQ == nil && req.Team == nil {
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

	newHash, err := security.HashPassword("1111", h.cfg.PasswordHashIterations)
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
	response.JSON(w, http.StatusOK, updated.ToResponse())
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

// --- Organization endpoints ---

// ListOrganizations handles GET /auth/organizations?type=hq|team (public, no admin required)
func (h *AuthHandler) ListOrganizations(w http.ResponseWriter, r *http.Request) {
	orgType := r.URL.Query().Get("type")
	if orgType != "hq" && orgType != "team" {
		response.Error(w, http.StatusBadRequest, "type must be hq or team")
		return
	}
	orgs, err := h.repo.ListOrganizations(r.Context(), orgType)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.JSON(w, http.StatusOK, orgs)
}

// AdminCreateOrganization handles POST /auth/admin/organizations
func (h *AuthHandler) AdminCreateOrganization(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.organizations.create") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	var req struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Type != "hq" && req.Type != "team" {
		response.Error(w, http.StatusBadRequest, "type must be hq or team")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		response.Error(w, http.StatusBadRequest, "name required")
		return
	}

	org, err := h.repo.CreateOrganization(r.Context(), req.Type, strings.TrimSpace(req.Name))
	if err != nil {
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			response.Error(w, http.StatusConflict, "Already exists")
			return
		}
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.JSON(w, http.StatusCreated, org)
}

// AdminDeleteOrganization handles DELETE /auth/admin/organizations/{id}
func (h *AuthHandler) AdminDeleteOrganization(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.organizations.delete") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid ID")
		return
	}

	if err := h.repo.DeleteOrganization(r.Context(), id); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Helpers ---

func (h *AuthHandler) writeAuditLog(r *http.Request, action string, actorID, actorEmail, targetID, targetEmail *string, before, after *json.RawMessage) {
	ip := r.Header.Get("X-Forwarded-For")
	if ip == "" {
		ip = r.RemoteAddr
	} else {
		ip = strings.Split(ip, ",")[0]
	}
	ua := r.Header.Get("User-Agent")
	reqID := r.Header.Get("X-Request-ID")
	path := r.URL.Path

	log := &model.AuditLog{
		Action:       action,
		ActorUserID:  actorID,
		ActorEmail:   actorEmail,
		TargetUserID: targetID,
		TargetEmail:  targetEmail,
		Before:       before,
		After:        after,
		RequestIP:    strPtr(ip),
		UserAgent:    strPtr(ua),
		RequestID:    strPtr(reqID),
		Path:         strPtr(path),
	}

	id, err := h.repo.CreateAuditLog(r.Context(), log)
	if err != nil {
		slog.Error("failed to create audit log", "error", err)
		return
	}

	slog.Info("audit", "action", action, "actor", derefStr(actorEmail), "target", derefStr(targetEmail), "audit_id", id)
}

func jsonRaw(v interface{}) *json.RawMessage {
	b, _ := json.Marshal(v)
	raw := json.RawMessage(b)
	return &raw
}

func strPtr(s string) *string { return &s }

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return i
}
