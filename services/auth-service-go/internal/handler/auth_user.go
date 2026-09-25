package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Register handles POST /auth/register. Self-service sign-up is off unless
// ALLOW_REGISTRATION is set; accounts are otherwise created by an admin.
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.AllowRegistration {
		response.Error(w, http.StatusNotFound, "Registration is disabled")
		return
	}
	var req model.RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if !strings.Contains(req.Email, "@") {
		response.Error(w, http.StatusBadRequest, "Invalid email")
		return
	}
	if err := security.ValidatePassword(req.Password, req.Email, h.cfg.PasswordMinLength); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	// Validate Team against organizations if provided
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
//
// Audit 정책: 성공 / 실패 둘 다 기록. 실패 사유는 generic ("Invalid credentials"
// — 사용자 존재 / 비밀번호 일치 여부 둘 다 같은 메시지) 이지만 audit log 에는
// 어떤 단계에서 실패인지 구분 (user_not_found vs password_mismatch) 저장 — security
// 분석 시 brute force 패턴 (특정 email 에 password_mismatch 다발) 탐지용.
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
		// failed login — user not found. actorID 없음 (인증 안 됐으니).
		// email 은 target_email 로 기록 (실제 존재 여부 정보 노출 안 되도록
		// actor 자리에는 안 둠).
		email := req.Email
		reason := jsonRaw(map[string]interface{}{"reason": "user_not_found"})
		h.writeAuditLog(r, "user.login.failed", nil, nil, nil, &email, nil, reason)
		response.Error(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	if !security.VerifyPassword(req.Password, user.PasswordHash) {
		// failed login — password mismatch. user 존재는 확인됨 → actor 자리에 기록.
		reason := jsonRaw(map[string]interface{}{"reason": "password_mismatch"})
		h.writeAuditLog(r, "user.login.failed", &user.ID, &user.Email, &user.ID, &user.Email, nil, reason)
		response.Error(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	permissions, err := h.repo.GetPermissionsByRoleID(r.Context(), user.RoleID)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to load permissions")
		return
	}

	// JWT carries a per-cluster permission matrix (step 06); the flat
	// `permissions` list is kept only for the UserResponse the frontend reads.
	matrix, err := h.buildPermissionMatrix(r.Context(), user.ID, permissions)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to build permissions")
		return
	}

	clusterRoles, err := h.repo.ListUserClusterRoleNames(r.Context(), user.ID)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to load cluster roles")
		return
	}
	token, err := h.jwtMgr.CreateToken(user.ID, user.Email, user.RoleName, matrix, clusterRoles, user.TokenVersion)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to create token")
		return
	}
	h.setAuthCookie(w, r, token)

	// successful login — actor + target 둘 다 같은 user (본인 로그인).
	h.writeAuditLog(r, "user.login.success", &user.ID, &user.Email, &user.ID, &user.Email, nil, nil)

	response.JSON(w, http.StatusOK, model.LoginResponse{
		AccessToken: token,
		TokenType:   "bearer",
		User:        user.ToResponseWithPermissions(permissions),
	})
}

// setAuthCookie stores the token in the HttpOnly session cookie (what browser
// WebSocket upgrades authenticate with).
func (h *AuthHandler) setAuthCookie(w http.ResponseWriter, r *http.Request, token string) {
	secure := r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name:     h.cfg.AuthCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   h.cfg.JWTExpiresMinutes * 60,
		HttpOnly: true,
		Secure:   secure,
		// Strict: the cookie never rides a cross-site request. Deep links still
		// work — the first request only fetches the SPA's static HTML.
		SameSite: http.SameSiteStrictMode,
	})
}

// Refresh handles POST /auth/refresh: re-issues a token for the caller from
// the current database state (role, cluster grants, token_version), so a
// change made after login takes effect without a password prompt and the
// browser session slides as long as the user stays active. The current token
// must still be valid (the auth middleware checks signature, expiry and tv).
func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
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
	permissions, err := h.repo.GetPermissionsByRoleID(r.Context(), user.RoleID)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to load permissions")
		return
	}
	matrix, err := h.buildPermissionMatrix(r.Context(), user.ID, permissions)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to build permissions")
		return
	}
	clusterRoles, err := h.repo.ListUserClusterRoleNames(r.Context(), user.ID)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to load cluster roles")
		return
	}
	token, err := h.jwtMgr.CreateToken(user.ID, user.Email, user.RoleName, matrix, clusterRoles, user.TokenVersion)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to create token")
		return
	}
	h.setAuthCookie(w, r, token)
	h.writeAuditLog(r, "user.token.refresh", &user.ID, &user.Email, &user.ID, &user.Email, nil, nil)

	response.JSON(w, http.StatusOK, model.LoginResponse{
		AccessToken: token,
		TokenType:   "bearer",
		User:        user.ToResponseWithPermissions(permissions),
	})
}

// Logout handles POST /auth/logout
//
// Audit 정책: cookie 의 JWT 에서 user 정보 추출해 기록. cookie 없거나 expired 면
// audit 없이 진행 (silent logout). 세션 종료는 보안 사고 대응 timeline 의 마지막
// 지점이라 누락 시 "user 가 언제까지 활동" 추적 어렵다.
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	// JWT 가 있으면 actor 정보 audit. middleware 가 r.Context 에 payload 채움.
	if payload, ok := auth.FromContext(r.Context()); ok {
		h.writeAuditLog(r, "user.logout", &payload.UserID, &payload.Email, &payload.UserID, &payload.Email, nil, nil)
	}

	// Same attributes as setAuthCookie so the browser matches the cookie it holds.
	http.SetCookie(w, &http.Cookie{
		Name:     h.cfg.AuthCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteStrictMode,
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
	// The browser holds the token only as an HttpOnly cookie, so it cannot
	// read the per-cluster matrix from the JWT; hand it over here (same
	// buildPermissionMatrix the token is issued from).
	matrix, _ := h.buildPermissionMatrix(r.Context(), user.ID, permissions)
	if matrix == nil {
		matrix = auth.PermissionMatrix{}
	}
	clusterRoles, _ := h.repo.ListUserClusterRoleNames(r.Context(), user.ID)
	if clusterRoles == nil {
		clusterRoles = map[string]string{}
	}
	response.JSON(w, http.StatusOK, struct {
		model.UserResponse
		PermissionsMatrix auth.PermissionMatrix `json:"permissions_matrix"`
		ClusterRoles      map[string]string     `json:"cluster_roles"`
		TokenTTLMinutes   int                   `json:"token_ttl_minutes"`
	}{user.ToResponseWithPermissions(permissions), matrix, clusterRoles, h.cfg.JWTExpiresMinutes})
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
	user, err := h.repo.GetUserByID(r.Context(), payload.UserID)
	if err != nil || user == nil {
		response.Error(w, http.StatusUnauthorized, "User not found")
		return
	}
	if err := security.ValidatePassword(req.NewPassword, user.Email, h.cfg.PasswordMinLength); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
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
	// Other sessions of this user must log in again with the new password.
	// The caller's own token is refreshed by the client right after.
	_ = h.repo.BumpTokenVersion(r.Context(), user.ID)

	// Audit log
	h.writeAuditLog(r, "user.password.change", &payload.UserID, &user.Email, &user.ID, &user.Email, nil, nil)

	updated, _ := h.repo.GetUserByID(r.Context(), user.ID)
	if updated == nil {
		updated = user
	}
	response.JSON(w, http.StatusOK, updated.ToResponse())
}
