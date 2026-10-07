package handler

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// API keys: a long-lived credential a user issues for automation (CI, scripts,
// other tools) instead of putting a password in it.
//
// A key is a random value shown once; only its SHA-256 is stored. It is not a
// bearer token for the services: the client exchanges it (POST /auth/token)
// for a short access token — the same JWT a sign-in gets, with the user's
// permissions of that moment cut down to the key's clusters and role ceiling
// (api_keys_scope.go) and an "akid" claim. Every other service keeps
// validating tokens as before; revoking a key refuses the next exchange, and
// a token_version bump revokes exchanged tokens like any other.
//
//   GET    /api/v1/auth/api-keys/config
//   GET    /api/v1/auth/api-keys                     (own)
//   POST   /api/v1/auth/api-keys                     { name, expires_in_days, cluster_ids?, role_ceiling? }
//   DELETE /api/v1/auth/api-keys/{id}                (own)
//   POST   /api/v1/auth/token                        Authorization: Bearer kbk_…  (public; the gateway rate-limits it like sign-in)
//   GET    /api/v1/auth/admin/users/{user_id}/api-keys        admin.users.update
//   DELETE /api/v1/auth/admin/users/{user_id}/api-keys/{id}   admin.users.update

const (
	apiKeyValuePrefix = "kbk_"
	apiKeyPrefixLen   = 12 // what lists and audit rows show of a key
	apiKeyNameMax     = 64

	// Audit actions (docs/audit-log-plan.md §5-2).
	auditAPIKeyCreate      = "user.apikey.create"
	auditAPIKeyDelete      = "user.apikey.delete"
	auditAPIKeyExchange    = "user.apikey.exchange"
	auditAdminAPIKeyDelete = "admin.apikey.delete"
)

// apiKeyCeilings are the roles a key may be capped at (built-in cluster roles).
var apiKeyCeilings = map[string]string{"read": "Read", "write": "Write", "admin": "Admin"}

type apiKeysConfigResponse struct {
	Enabled bool `json:"enabled"`
	MaxDays int  `json:"max_days"`
}

// APIKeysConfig tells the UI whether keys can be issued and for how long.
func (h *AuthHandler) APIKeysConfig(w http.ResponseWriter, r *http.Request) {
	response.JSON(w, http.StatusOK, apiKeysConfigResponse{Enabled: h.cfg.APIKeys.Enabled, MaxDays: h.cfg.APIKeys.MaxDays})
}

// ListMyAPIKeys lists the signed-in user's keys (never their values).
func (h *AuthHandler) ListMyAPIKeys(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	keys, err := h.repo.ListAPIKeys(r.Context(), payload.UserID)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, keys)
}

type createAPIKeyRequest struct {
	Name          string   `json:"name"`
	ExpiresInDays int      `json:"expires_in_days"`
	ClusterIDs    []string `json:"cluster_ids"`
	RoleCeiling   string   `json:"role_ceiling"`
}

type createdAPIKeyResponse struct {
	repository.APIKey
	Key string `json:"key"` // the value, shown this once
}

// CreateAPIKey issues a key for the signed-in user. The clusters must be ones
// the user reaches now; an empty list means every cluster they reach at
// exchange time. The ceiling defaults to Read.
func (h *AuthHandler) CreateAPIKey(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if !h.cfg.APIKeys.Enabled {
		response.Error(w, http.StatusForbidden, "API keys are disabled on this installation")
		return
	}
	var req createAPIKeyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > apiKeyNameMax {
		response.Error(w, http.StatusBadRequest, fmt.Sprintf("name is required (up to %d characters)", apiKeyNameMax))
		return
	}
	if req.ExpiresInDays < 1 || req.ExpiresInDays > h.cfg.APIKeys.MaxDays {
		response.Error(w, http.StatusBadRequest, fmt.Sprintf("expires_in_days must be between 1 and %d", h.cfg.APIKeys.MaxDays))
		return
	}
	ceiling := "Read"
	if c := strings.TrimSpace(req.RoleCeiling); c != "" {
		canonical, ok := apiKeyCeilings[strings.ToLower(c)]
		if !ok {
			response.Error(w, http.StatusBadRequest, "role_ceiling must be Read, Write or Admin")
			return
		}
		ceiling = canonical
	}
	user, err := h.repo.GetUserByID(r.Context(), payload.UserID)
	if err != nil || user == nil {
		response.Error(w, http.StatusUnauthorized, "User not found")
		return
	}
	var clusterIDs []string
	if len(req.ClusterIDs) > 0 {
		reach, err := h.reachableClusterIDs(r.Context(), user)
		if err != nil {
			response.InternalError(w, r, err)
			return
		}
		seen := map[string]struct{}{}
		for _, id := range req.ClusterIDs {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			if !containsString(reach, id) {
				response.Error(w, http.StatusBadRequest, fmt.Sprintf("cluster %q is not one you can reach", id))
				return
			}
			if _, dup := seen[id]; !dup {
				seen[id] = struct{}{}
				clusterIDs = append(clusterIDs, id)
			}
		}
	}

	value, hash, prefix, err := newAPIKeyValue()
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	now := time.Now().UTC()
	key := &repository.APIKey{
		ID:          uuid.NewString(),
		UserID:      user.ID,
		Name:        name,
		KeyPrefix:   prefix,
		ClusterIDs:  clusterIDs,
		RoleCeiling: ceiling,
		ExpiresAt:   now.Add(time.Duration(req.ExpiresInDays) * 24 * time.Hour),
		CreatedAt:   now,
	}
	err = h.repo.CreateAPIKey(r.Context(), key, hash)
	h.auditAPIKey(r, auditAPIKeyCreate, user.ID, user.Email, key.ID, user.Email, apiKeyAuditFields(key), err)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusCreated, createdAPIKeyResponse{APIKey: *key, Key: value})
}

// DeleteMyAPIKey revokes one of the signed-in user's keys.
func (h *AuthHandler) DeleteMyAPIKey(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	id := chi.URLParam(r, "id")
	key, err := h.repo.DeleteAPIKey(r.Context(), id, payload.UserID)
	if errors.Is(err, repository.ErrAPIKeyNotFound) {
		response.Error(w, http.StatusNotFound, "API key not found")
		return
	}
	var fields map[string]any
	if key != nil {
		fields = apiKeyAuditFields(key)
	}
	h.auditAPIKey(r, auditAPIKeyDelete, payload.UserID, payload.Email, id, payload.Email, fields, err)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// AdminListUserAPIKeys lists another user's keys (admin.users.update).
func (h *AuthHandler) AdminListUserAPIKeys(w http.ResponseWriter, r *http.Request) {
	if _, ok := requirePerm(w, r, "admin.users.update"); !ok {
		return
	}
	keys, err := h.repo.ListAPIKeys(r.Context(), chi.URLParam(r, "user_id"))
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, keys)
}

// AdminDeleteUserAPIKey revokes another user's key (admin.users.update).
func (h *AuthHandler) AdminDeleteUserAPIKey(w http.ResponseWriter, r *http.Request) {
	actor, ok := requirePerm(w, r, "admin.users.update")
	if !ok {
		return
	}
	userID, id := chi.URLParam(r, "user_id"), chi.URLParam(r, "id")
	ownerEmail := ""
	if owner, err := h.repo.GetUserByID(r.Context(), userID); err == nil && owner != nil {
		ownerEmail = owner.Email
	}
	key, err := h.repo.DeleteAPIKey(r.Context(), id, userID)
	if errors.Is(err, repository.ErrAPIKeyNotFound) {
		response.Error(w, http.StatusNotFound, "API key not found")
		return
	}
	var fields map[string]any
	if key != nil {
		fields = apiKeyAuditFields(key)
	}
	h.auditAPIKey(r, auditAdminAPIKeyDelete, actor.UserID, actor.Email, id, ownerEmail, fields, err)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type exchangeResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"` // seconds
}

// ExchangeAPIKey turns a key into an access token. Unknown, expired and
// revoked keys all get the same 401; every attempt leaves an audit row.
func (h *AuthHandler) ExchangeAPIKey(w http.ResponseWriter, r *http.Request) {
	raw := bearerAPIKey(r)
	if raw == "" {
		response.Error(w, http.StatusUnauthorized, "API key required (Authorization: Bearer kbk_…)")
		return
	}
	prefix := raw
	if len(prefix) > apiKeyPrefixLen {
		prefix = prefix[:apiKeyPrefixLen]
	}
	if !h.cfg.APIKeys.Enabled {
		h.auditAPIKey(r, auditAPIKeyExchange, "", "", prefix, "", nil, errors.New("api keys disabled"))
		response.Error(w, http.StatusForbidden, "API keys are disabled on this installation")
		return
	}
	key, err := h.repo.GetAPIKeyByHash(r.Context(), hashAPIKey(raw))
	if errors.Is(err, repository.ErrAPIKeyNotFound) {
		h.auditAPIKey(r, auditAPIKeyExchange, "", "", prefix, "", nil, errors.New("unknown or revoked key"))
		response.Error(w, http.StatusUnauthorized, "Invalid API key")
		return
	}
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	now := time.Now()
	user, uerr := h.repo.GetUserByID(r.Context(), key.UserID)
	if uerr != nil || user == nil {
		h.auditAPIKey(r, auditAPIKeyExchange, "", "", key.ID, "", apiKeyAuditFields(key), errors.New("owner not found"))
		response.Error(w, http.StatusUnauthorized, "Invalid API key")
		return
	}
	refuse := func(reason string) {
		h.auditAPIKey(r, auditAPIKeyExchange, user.ID, user.Email, key.ID, user.Email, apiKeyAuditFields(key), errors.New(reason))
		response.Error(w, http.StatusUnauthorized, "Invalid API key")
	}
	if now.After(key.ExpiresAt) {
		refuse("key expired")
		return
	}
	if strings.EqualFold(user.RoleName, "pending") {
		refuse("owner pending approval")
		return
	}
	if user.DormantLockedAt != nil {
		refuse("owner dormant")
		return
	}

	permissions, err := h.repo.GetPermissionsByRoleID(r.Context(), user.RoleID)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	matrix, err := h.buildPermissionMatrix(r.Context(), user.ID, permissions)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	roles, err := h.repo.ListUserClusterRoleNames(r.Context(), user.ID)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	clusterIDs := key.ClusterIDs
	if clusterIDs == nil {
		if clusterIDs, err = h.reachableClusterIDs(r.Context(), user); err != nil {
			response.InternalError(w, r, err)
			return
		}
	}
	ceiling, err := h.repo.GetRoleByName(r.Context(), key.RoleCeiling)
	if err != nil || ceiling == nil {
		response.InternalError(w, r, fmt.Errorf("api key ceiling role %q: %w", key.RoleCeiling, err))
		return
	}
	narrowed, narrowedRoles := narrowForAPIKey(matrix, roles, clusterIDs, key.RoleCeiling, ceiling.Permissions)

	token, err := h.jwtMgr.CreateAPIKeyToken(user.ID, user.Email, user.RoleName, narrowed, narrowedRoles, user.TokenVersion, key.ID)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	if err := h.repo.TouchAPIKey(r.Context(), key.ID, audit.ClientIP(r), now); err != nil {
		slog.Warn("api key: record last use", "key", key.ID, "err", err)
	}
	fields := apiKeyAuditFields(key)
	fields["akid"] = key.ID
	fields["clusters"] = sortedKeys(narrowed)
	h.auditAPIKey(r, auditAPIKeyExchange, user.ID, user.Email, key.ID, user.Email, fields, nil)
	response.JSON(w, http.StatusOK, exchangeResponse{AccessToken: token, TokenType: "bearer", ExpiresIn: h.cfg.JWTExpiresMinutes * 60})
}

// reachableClusterIDs is every cluster the user has a grant on — or every
// registered cluster for a global superuser ("*"), who reaches them all.
func (h *AuthHandler) reachableClusterIDs(ctx context.Context, user *model.User) ([]string, error) {
	permissions, err := h.repo.GetPermissionsByRoleID(ctx, user.RoleID)
	if err != nil {
		return nil, err
	}
	if containsString(permissions, "*") {
		return h.repo.ListClusterIDs(ctx)
	}
	return h.repo.ListAccessibleClusterIDs(ctx, user.ID)
}

// newAPIKeyValue draws a key: "kbk_" + 32 random bytes (base64url), with its
// SHA-256 (what is stored) and the prefix lists show.
func newAPIKeyValue() (value, hash, prefix string, err error) {
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		return "", "", "", err
	}
	value = apiKeyValuePrefix + base64.RawURLEncoding.EncodeToString(raw)
	return value, hashAPIKey(value), value[:apiKeyPrefixLen], nil
}

func hashAPIKey(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// bearerAPIKey returns the key in "Authorization: Bearer kbk_…", or "".
func bearerAPIKey(r *http.Request) string {
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || !strings.HasPrefix(parts[1], apiKeyValuePrefix) {
		return ""
	}
	return parts[1]
}

func apiKeyAuditFields(key *repository.APIKey) map[string]any {
	return map[string]any{
		"name":         key.Name,
		"key_prefix":   key.KeyPrefix,
		"cluster_ids":  key.ClusterIDs,
		"role_ceiling": key.RoleCeiling,
		"expires_at":   key.ExpiresAt.UTC().Format(time.RFC3339),
	}
}

// auditAPIKey writes one row: target = the key (id, or the presented prefix
// when no key matched), target_email = its owner.
func (h *AuthHandler) auditAPIKey(r *http.Request, action, actorID, actorEmail, targetID, ownerEmail string, after map[string]any, opErr error) {
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAuth
	rec.Action = action
	rec.TargetType = "api_key"
	rec.TargetID = targetID
	rec.TargetEmail = ownerEmail
	rec.ActorUserID = actorID
	rec.ActorEmail = actorEmail
	if after != nil {
		rec.After = audit.MustJSON(after)
	}
	if opErr != nil {
		rec.Result = audit.ResultFailure
		rec.Error = opErr.Error()
	}
	if _, err := h.auditStore.Write(r.Context(), rec); err != nil {
		slog.Error("failed to create audit log", "error", err, "action", action)
	}
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func sortedKeys(m auth.PermissionMatrix) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
