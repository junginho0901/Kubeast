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

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

type AuthHandler struct {
	repo       *repository.Repository
	jwtMgr     *security.JWTManager
	cfg        config.Config
	auditStore audit.Store
}

func NewAuthHandler(repo *repository.Repository, jwtMgr *security.JWTManager, cfg config.Config, auditStore audit.Store) *AuthHandler {
	return &AuthHandler{repo: repo, jwtMgr: jwtMgr, cfg: cfg, auditStore: auditStore}
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

	token, err := h.jwtMgr.CreateToken(user.ID, user.Email, user.RoleName, permissions)
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
