package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// AdminBulkUpdateRole handles PATCH /auth/admin/users/bulk-role
func (h *AuthHandler) AdminBulkUpdateRole(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(h.auditStore, w, r, "admin.users.update")
	if !ok {
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
	// Ceiling: the grantor must hold everything the role gives.
	if missing := missingPermissions(payload, targetRole.Permissions, ""); len(missing) > 0 {
		err := ceilingError(missing)
		writeAudit(h.auditStore, r, payload, auditEvent{action: "user.role.update", targetType: "user",
			after: map[string]any{"role": targetRole.Name, "bulk": true, "user_ids": len(req.UserIDs)}, err: err})
		response.Error(w, http.StatusForbidden, err.Error())
		return
	}

	// Every account first: one out of reach refuses the whole call, as the role's
	// own ceiling above does, with a failure row per refused account.
	targets := make([]*model.User, 0, len(req.UserIDs))
	var refused []error
	var failed []model.BulkRoleFailure
	leftOut := func(uid, email, reason string, err error) {
		failed = append(failed, model.BulkRoleFailure{UserID: uid, Email: email, Reason: reason})
		writeAudit(h.auditStore, r, payload, auditEvent{
			action: "user.role.update", targetType: "user", targetID: uid, targetEmail: email,
			after: map[string]any{"role": targetRole.Name, "bulk": true}, err: err,
		})
	}
	for _, uid := range req.UserIDs {
		if uid == payload.UserID {
			leftOut(uid, payload.Email, model.BulkRoleFailedSelf, errors.New("cannot change your own role"))
			continue
		}
		target, err := h.repo.GetUserByID(r.Context(), uid)
		if err != nil {
			slog.Error("bulk role: read account failed", "user_id", uid, "err", err)
			leftOut(uid, "", model.BulkRoleFailedChange, fmt.Errorf("read the account: %w", err))
			continue
		}
		if target == nil {
			leftOut(uid, "", model.BulkRoleFailedNotFound, errors.New("no such account"))
			continue
		}
		err = h.globalCeiling(r.Context(), payload, target)
		if err != nil && !errors.Is(err, errCeiling) {
			response.InternalError(w, r, err)
			return
		}
		if err != nil {
			refused = append(refused, err)
			writeAudit(h.auditStore, r, payload, auditEvent{
				action: "user.role.update", targetType: "user", targetID: uid, targetEmail: target.Email,
				before: map[string]any{"role": target.RoleName},
				after:  map[string]any{"role": targetRole.Name, "bulk": true}, err: err,
			})
			continue
		}
		targets = append(targets, target)
	}
	if len(refused) > 0 {
		msg := refused[0].Error()
		if len(refused) > 1 {
			msg += fmt.Sprintf(" (and %d more accounts)", len(refused)-1)
		}
		response.Error(w, http.StatusForbidden, msg)
		return
	}

	updated := make([]model.UserResponse, 0, len(targets))
	for _, target := range targets {
		uid := target.ID
		err := h.repo.UpdateUserRoleEndingTokens(r.Context(), uid, req.RoleID)
		// One audit row per account, like the single-user path.
		writeAudit(h.auditStore, r, payload, auditEvent{
			action: "user.role.update", targetType: "user", targetID: uid, targetEmail: target.Email,
			before: map[string]any{"role": target.RoleName},
			after:  map[string]any{"role": targetRole.Name, "bulk": true}, err: err,
		})
		if err != nil {
			slog.Error("bulk role: change failed", "user_id", uid, "err", err)
			failed = append(failed, model.BulkRoleFailure{UserID: uid, Email: target.Email, Reason: model.BulkRoleFailedChange})
			continue
		}
		u, _ := h.repo.GetUserByID(r.Context(), uid)
		if u != nil {
			updated = append(updated, u.ToResponse())
		}
	}

	changeFailed := slices.ContainsFunc(failed, func(f model.BulkRoleFailure) bool { return f.Reason == model.BulkRoleFailedChange })
	switch {
	case len(failed) == 0:
		response.JSON(w, http.StatusOK, updated)
	case len(updated) == 0 && changeFailed:
		response.JSON(w, http.StatusInternalServerError, model.BulkRoleResponse{
			Detail: fmt.Sprintf("no account was changed (%d left as they were)", len(failed)), Updated: updated, Failed: failed,
		})
	default:
		response.JSON(w, http.StatusMultiStatus, model.BulkRoleResponse{Updated: updated, Failed: failed})
	}
}

// AdminBulkCreateUsers handles POST /auth/admin/users/bulk: it creates who it can and names everyone it left out.
func (h *AuthHandler) AdminBulkCreateUsers(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(h.auditStore, w, r, "admin.users.create")
	if !ok {
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

	created := []model.UserResponse{}
	failed := []model.BulkCreateFailure{}
	bulkErrors := []model.BulkError{}
	noteFailed := func(email, reason, detail, message string) {
		failed = append(failed, model.BulkCreateFailure{Email: email, Reason: reason, Detail: detail})
		bulkErrors = append(bulkErrors, model.BulkError{Email: email, Message: message})
	}
	// An account never written still leaves its failure row, as an account a bulk role change left out does.
	leftOut := func(email, role, reason, detail, message string) {
		noteFailed(email, reason, detail, message)
		after := map[string]any{"email": email, "reason": reason, "bulk": true}
		if role != "" {
			after["role"] = role
		}
		writeAudit(h.auditStore, r, payload, auditEvent{action: "user.create", targetType: "user", targetEmail: email, after: after, err: errors.New(message)})
	}

	for _, u := range req.Users {
		if u.Name == "" || !strings.Contains(u.Email, "@") || u.Password == "" {
			leftOut(u.Email, "", model.BulkCreateFailedFields, "", "Missing required fields (name, email, password)")
			continue
		}
		if err := checkAccountName(u.Email); err != nil {
			leftOut(u.Email, "", model.BulkCreateFailedName, "", err.Error())
			continue
		}
		if err := security.ValidatePassword(u.Password, u.Email, h.cfg.PasswordMinLength); err != nil {
			leftOut(u.Email, "", model.BulkCreateFailedPassword, err.Error(), err.Error())
			continue
		}

		// Validate role_id — default to the Member account level (no global
		// access; cluster access comes from per-cluster grants).
		roleID := u.RoleID
		if roleID == 0 {
			memberRole, _ := h.repo.GetRoleByName(r.Context(), "Member")
			if memberRole != nil {
				roleID = memberRole.ID
			}
		}
		targetRole, err := h.repo.GetRoleByID(r.Context(), roleID)
		if err != nil || targetRole == nil {
			leftOut(u.Email, "", model.BulkCreateFailedRole, "", "Invalid role_id")
			continue
		}
		if missing := missingPermissions(payload, targetRole.Permissions, ""); len(missing) > 0 {
			leftOut(u.Email, targetRole.Name, model.BulkCreateFailedCeiling, strings.Join(missing, ", "), ceilingError(missing).Error())
			continue
		}

		if u.Team != nil && strings.TrimSpace(*u.Team) != "" {
			if ok, _ := h.repo.OrganizationExists(r.Context(), "team", strings.TrimSpace(*u.Team)); !ok {
				leftOut(u.Email, targetRole.Name, model.BulkCreateFailedTeam, *u.Team, "Invalid Team: "+*u.Team)
				continue
			}
		}

		existing, _ := h.repo.GetUserByEmail(r.Context(), u.Email)
		if existing != nil {
			leftOut(u.Email, targetRole.Name, model.BulkCreateFailedExists, "", "Email already exists")
			continue
		}

		hash, err := security.HashPassword(u.Password, h.cfg.PasswordHashIterations)
		if err != nil {
			slog.Error("bulk create: hash failed", "email", u.Email, "err", err)
			leftOut(u.Email, targetRole.Name, model.BulkCreateFailedWrite, "", "Failed to hash password")
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

		err = h.repo.CreateUser(r.Context(), user)
		// One audit row per account, like the single-user path.
		writeAudit(h.auditStore, r, payload, auditEvent{
			action: "user.create", targetType: "user", targetID: user.ID, targetEmail: user.Email,
			after: map[string]any{"name": user.Name, "email": user.Email, "role": targetRole.Name, "team": derefStr(u.Team), "bulk": true}, err: err,
		})
		if err != nil {
			slog.Error("bulk create: write failed", "email", u.Email, "err", err)
			noteFailed(u.Email, model.BulkCreateFailedWrite, "", "Failed to create the user")
			continue
		}

		created = append(created, user.ToResponse())
	}

	answer := model.BulkCreateUserResponse{Created: created, Failed: failed, Errors: bulkErrors}
	writeFailed := slices.ContainsFunc(failed, func(f model.BulkCreateFailure) bool { return f.Reason == model.BulkCreateFailedWrite })
	switch {
	case len(failed) == 0:
		response.JSON(w, http.StatusOK, answer)
	case len(created) == 0 && writeFailed:
		answer.Detail = fmt.Sprintf("no account was created (%d left out)", len(failed))
		response.JSON(w, http.StatusInternalServerError, answer)
	default:
		response.JSON(w, http.StatusMultiStatus, answer)
	}
}

// AdminCreateUser handles POST /auth/admin/users
func (h *AuthHandler) AdminCreateUser(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(h.auditStore, w, r, "admin.users.create")
	if !ok {
		return
	}

	var req model.AdminCreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// An account never written leaves its failure row and says why in the words of a bulk creation's answer.
	refuse := func(status int, role, reason, detail, message string) {
		after := map[string]any{"email": req.Email, "reason": reason}
		if role != "" {
			after["role"] = role
		}
		writeAudit(h.auditStore, r, payload, auditEvent{action: "user.create", targetType: "user", targetEmail: req.Email, after: after, err: errors.New(message)})
		response.JSON(w, status, model.CreateUserRefusal{Detail: message, Reason: reason, ReasonDetail: detail})
	}

	if req.Name == "" {
		refuse(http.StatusBadRequest, "", model.BulkCreateFailedFields, "", "Name required")
		return
	}
	if msg := nameTooLong("name", req.Name, userNameMax); msg != "" {
		refuse(http.StatusBadRequest, "", model.BulkCreateFailedFields, "", msg)
		return
	}
	if !strings.Contains(req.Email, "@") {
		refuse(http.StatusBadRequest, "", model.BulkCreateFailedFields, "", "Invalid email")
		return
	}
	if err := checkAccountName(req.Email); err != nil {
		refuse(http.StatusBadRequest, "", model.BulkCreateFailedName, "", err.Error())
		return
	}
	if err := security.ValidatePassword(req.Password, req.Email, h.cfg.PasswordMinLength); err != nil {
		refuse(http.StatusBadRequest, "", model.BulkCreateFailedPassword, err.Error(), err.Error())
		return
	}

	// Validate role_id — default to the Member account level (no global access;
	// cluster access comes from per-cluster grants).
	roleID := req.RoleID
	if roleID == 0 {
		memberRole, _ := h.repo.GetRoleByName(r.Context(), "Member")
		if memberRole != nil {
			roleID = memberRole.ID
		}
	}
	targetRole, err := h.repo.GetRoleByID(r.Context(), roleID)
	if err != nil || targetRole == nil {
		refuse(http.StatusBadRequest, "", model.BulkCreateFailedRole, "", "Invalid role_id")
		return
	}
	// Ceiling: the grantor must hold everything the role gives.
	if missing := missingPermissions(payload, targetRole.Permissions, ""); len(missing) > 0 {
		refuse(http.StatusForbidden, targetRole.Name, model.BulkCreateFailedCeiling, strings.Join(missing, ", "), ceilingError(missing).Error())
		return
	}

	// Validate Team
	if req.Team != nil && strings.TrimSpace(*req.Team) != "" {
		if ok, _ := h.repo.OrganizationExists(r.Context(), "team", strings.TrimSpace(*req.Team)); !ok {
			refuse(http.StatusBadRequest, targetRole.Name, model.BulkCreateFailedTeam, *req.Team, "Invalid Team value")
			return
		}
	}

	existing, _ := h.repo.GetUserByEmail(r.Context(), req.Email)
	if existing != nil {
		refuse(http.StatusConflict, targetRole.Name, model.BulkCreateFailedExists, "", "Email already exists")
		return
	}

	hash, err := security.HashPassword(req.Password, h.cfg.PasswordHashIterations)
	if err != nil {
		refuse(http.StatusInternalServerError, targetRole.Name, model.BulkCreateFailedWrite, "", "Failed to hash password")
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
		h.writeAuditFailure(r, "user.create", &payload.UserID, &payload.Email, nil, &user.Email, err.Error(),
			jsonRaw(map[string]string{"email": user.Email, "role": targetRole.Name, "name": user.Name, "reason": model.BulkCreateFailedWrite}))
		slog.Error("create user: write failed", "email", user.Email, "err", err)
		response.JSON(w, http.StatusInternalServerError, model.CreateUserRefusal{Detail: "internal server error", Reason: model.BulkCreateFailedWrite})
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
	if _, ok := requirePerm(h.auditStore, w, r, "admin.users.read"); !ok {
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
		response.InternalError(w, r, err)
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
	payload, ok := requirePerm(h.auditStore, w, r, "admin.users.update")
	if !ok {
		return
	}

	userID := chi.URLParam(r, "user_id")

	var req model.AdminUpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.RoleID != nil && userID == payload.UserID {
		writeAudit(h.auditStore, r, payload, auditEvent{action: "user.role.update", targetType: "user", targetID: userID, targetEmail: payload.Email,
			after: map[string]any{"role_id": *req.RoleID}, err: errors.New("cannot change your own role")})
		response.Error(w, http.StatusForbidden, "Cannot change your own role")
		return
	}

	target, err := h.repo.GetUserByID(r.Context(), userID)
	if err != nil || target == nil {
		response.Error(w, http.StatusNotFound, "User not found")
		return
	}

	if req.RoleID != nil && h.refuseCeiling(w, r, payload, target, h.globalCeiling(r.Context(), payload, target),
		auditEvent{action: "user.role.update", before: map[string]any{"role": target.RoleName}}) {
		return
	}

	// Validate name
	if req.Name != nil {
		trimmed := strings.TrimSpace(*req.Name)
		if trimmed == "" {
			response.Error(w, http.StatusBadRequest, "Name cannot be empty")
			return
		}
		if msg := nameTooLong("name", trimmed, userNameMax); msg != "" {
			response.Error(w, http.StatusBadRequest, msg)
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
		// Ceiling: the grantor must hold everything the role gives.
		if missing := missingPermissions(payload, targetRole.Permissions, ""); len(missing) > 0 {
			err := ceilingError(missing)
			writeAudit(h.auditStore, r, payload, auditEvent{action: "user.role.update", targetType: "user", targetID: userID, targetEmail: target.Email,
				before: map[string]any{"role": oldRoleName}, after: map[string]any{"role": targetRole.Name}, err: err})
			response.Error(w, http.StatusForbidden, err.Error())
			return
		}
		newRoleName = targetRole.Name
	}

	// Apply profile updates (name/team)
	if req.Name != nil || req.Team != nil {
		if err := h.repo.UpdateUserProfile(r.Context(), userID, req.Name, req.Team); err != nil {
			h.writeAuditFailure(r, "user.update", &payload.UserID, &payload.Email, &userID, nil, err.Error(), nil)
			response.InternalError(w, r, err)
			return
		}
	}

	// Apply role update
	if req.RoleID != nil {
		if err := h.repo.UpdateUserRoleEndingTokens(r.Context(), userID, *req.RoleID); err != nil {
			h.writeAuditFailure(r, "user.role.update", &payload.UserID, &payload.Email, &userID, nil, err.Error(), nil)
			response.InternalError(w, r, err)
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
	payload, ok := requirePerm(h.auditStore, w, r, "admin.users.update")
	if !ok {
		return
	}

	userID := chi.URLParam(r, "user_id")
	target, err := h.repo.GetUserByID(r.Context(), userID)
	if err != nil || target == nil {
		response.Error(w, http.StatusNotFound, "User not found")
		return
	}
	if h.refuseCeiling(w, r, payload, target, h.accountCeiling(r.Context(), payload, target), auditEvent{action: "user.password.reset"}) {
		return
	}

	tempPassword, err := security.GenerateRandomPassword(16)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to generate password")
		return
	}

	newHash, err := security.HashPassword(tempPassword, h.cfg.PasswordHashIterations)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to hash password")
		return
	}

	// A reset logs the user out everywhere.
	if err := h.repo.UpdateUserPasswordEndingTokens(r.Context(), userID, newHash); err != nil {
		h.writeAuditFailure(r, "user.password.reset", &payload.UserID, &payload.Email, &userID, &target.Email, err.Error(), nil)
		response.InternalError(w, r, err)
		return
	}
	_ = h.repo.ResetLoginFailures(r.Context(), userID) // and lifts a login lockout (H13)

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
	// An admin resetting their own password keeps this session, as a password change does: the page has to
	// show the new password before they sign in with it.
	if userID == payload.UserID {
		if token, err := h.issueToken(r.Context(), updated); err != nil {
			slog.Error("reset-password: re-issue session token", "user", updated.ID, "err", err)
		} else {
			h.setAuthCookie(w, r, token)
		}
	}
	response.JSON(w, http.StatusOK, model.AdminResetPasswordResponse{
		UserResponse:      updated.ToResponse(),
		TemporaryPassword: tempPassword,
	})
}

// AdminDeleteUser handles DELETE /auth/admin/users/{user_id}
func (h *AuthHandler) AdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(h.auditStore, w, r, "admin.users.delete")
	if !ok {
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
	if h.refuseCeiling(w, r, payload, target, h.globalCeiling(r.Context(), payload, target),
		auditEvent{action: "user.delete", before: map[string]any{"role": target.RoleName}}) {
		return
	}

	if err := h.repo.DeleteUser(r.Context(), userID); err != nil {
		h.writeAuditFailure(r, "user.delete", &payload.UserID, &payload.Email, &userID, &target.Email, err.Error(), nil)
		response.InternalError(w, r, err)
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
