package handler

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"golang.org/x/oauth2"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// OIDC login: one provider chosen by configuration (Keycloak, Google, any
// OpenID Connect issuer with discovery). Server-side authorization code flow
// with PKCE (RFC 9700); the browser only follows redirects and ends up with
// the same HttpOnly session cookie a password login sets. Claims → email,
// name, groups; groups → Kubeast role and per-cluster grants.

const (
	oidcStateCookie = "kubeast.oidc"
	oidcStateTTL    = 10 * time.Minute
)

// oidcClient holds the lazily discovered provider (discovery needs the
// network, so it is not done at startup and a provider outage does not stop
// the service).
type oidcClient struct {
	cfg      config.OIDCConfig
	mu       sync.Mutex
	provider *oidc.Provider
	oauth    *oauth2.Config
}

func newOIDCClient(cfg config.OIDCConfig) *oidcClient {
	return &oidcClient{cfg: cfg}
}

func (c *oidcClient) get(ctx context.Context) (*oidc.Provider, *oauth2.Config, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.provider != nil {
		return c.provider, c.oauth, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	p, err := oidc.NewProvider(ctx, c.cfg.IssuerURL)
	if err != nil {
		return nil, nil, fmt.Errorf("oidc discovery %s: %w", c.cfg.IssuerURL, err)
	}
	scopes := []string{oidc.ScopeOpenID}
	for _, s := range c.cfg.Scopes {
		if s = strings.TrimSpace(s); s != "" && s != oidc.ScopeOpenID {
			scopes = append(scopes, s)
		}
	}
	c.provider = p
	c.oauth = &oauth2.Config{
		ClientID:     c.cfg.ClientID,
		ClientSecret: c.cfg.ClientSecret,
		Endpoint:     p.Endpoint(),
		RedirectURL:  c.cfg.RedirectURL,
		Scopes:       scopes,
	}
	return c.provider, c.oauth, nil
}

// oidcState is what the login step remembers across the redirect, in an
// HMAC-signed cookie: CSRF state, ID-token nonce, PKCE verifier, the page to
// return to, and an expiry.
type oidcState struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Next     string `json:"next,omitempty"`
	Exp      int64  `json:"exp"`
}

func signState(key []byte, st oidcState) (string, error) {
	payload, err := json.Marshal(st)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func verifyState(key []byte, cookie string, now time.Time) (oidcState, error) {
	var st oidcState
	body, sig, ok := strings.Cut(cookie, ".")
	if !ok {
		return st, errors.New("malformed state cookie")
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(body))
	want, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(want, mac.Sum(nil)) {
		return st, errors.New("state cookie signature mismatch")
	}
	payload, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(payload, &st); err != nil {
		return st, err
	}
	if now.Unix() > st.Exp {
		return st, errors.New("state cookie expired")
	}
	return st, nil
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// safeNext keeps only a same-origin path so the login cannot be turned into an
// open redirect.
func safeNext(raw string) string {
	if raw == "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.HasPrefix(raw, "/\\") {
		return "/"
	}
	if u, err := url.Parse(raw); err != nil || u.Host != "" || u.Scheme != "" {
		return "/"
	}
	return raw
}

// oidcClaims is what the callback extracts from the ID token.
type oidcClaims struct {
	Email         string
	EmailVerified *bool
	Name          string
	Groups        []string
	HasGroups     bool // the groups claim was present (empty list still counts)
}

func extractClaims(raw map[string]any, cfg config.OIDCConfig) oidcClaims {
	c := oidcClaims{}
	if v, ok := raw[cfg.EmailClaim].(string); ok {
		c.Email = strings.ToLower(strings.TrimSpace(v))
	}
	if v, ok := raw["email_verified"].(bool); ok {
		c.EmailVerified = &v
	}
	if v, ok := raw[cfg.NameClaim].(string); ok {
		c.Name = strings.TrimSpace(v)
	}
	if v, ok := raw[cfg.GroupsClaim]; ok {
		c.HasGroups = true
		switch g := v.(type) {
		case []any:
			for _, x := range g {
				if s, ok := x.(string); ok && s != "" {
					c.Groups = append(c.Groups, s)
				}
			}
		case string: // some providers send a single group as a string
			if g != "" {
				c.Groups = []string{g}
			}
		}
	}
	return c
}

func domainAllowed(email string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	_, domain, ok := strings.Cut(email, "@")
	if !ok {
		return false
	}
	for _, d := range allowed {
		if strings.EqualFold(strings.TrimSpace(d), domain) {
			return true
		}
	}
	return false
}

// rolePrecedence orders roles so a user in several mapped groups gets the
// widest one. Account levels: Admin > custom role > Member > Pending;
// per-cluster grants: Admin > Write > Read. Ties break alphabetically.
func rolePrecedence(name string) int {
	switch name {
	case "Admin":
		return 0
	case "Write":
		return 1
	case "Read":
		return 2
	case "Member":
		return 4
	case "Pending":
		return 5
	}
	return 3
}

// mapRole returns the Kubeast role for the user's groups ("" when none maps).
func mapRole(groups []string, mapping map[string]string) string {
	var roles []string
	for _, g := range groups {
		if r, ok := mapping[g]; ok {
			roles = append(roles, r)
		}
	}
	if len(roles) == 0 {
		return ""
	}
	sort.SliceStable(roles, func(i, j int) bool {
		pi, pj := rolePrecedence(roles[i]), rolePrecedence(roles[j])
		if pi != pj {
			return pi < pj
		}
		return roles[i] < roles[j]
	})
	return roles[0]
}

// clusterGrants reads "<prefix><cluster-id>:<Role>" groups into cluster → role.
func clusterGrants(groups []string, prefix string) map[string]string {
	out := map[string]string{}
	if prefix == "" {
		return out
	}
	for _, g := range groups {
		if !strings.HasPrefix(g, prefix) {
			continue
		}
		id, role, ok := strings.Cut(strings.TrimPrefix(g, prefix), ":")
		if !ok || id == "" || role == "" {
			continue
		}
		if cur, exists := out[id]; !exists || rolePrecedence(role) < rolePrecedence(cur) {
			out[id] = role
		}
	}
	return out
}

// passwordLoginAllowed applies PASSWORD_LOGIN (on / admin-only / off).
func passwordLoginAllowed(cfg config.Config, email string) bool {
	switch cfg.PasswordLogin {
	case "off":
		return false
	case "admin-only":
		return strings.EqualFold(email, cfg.DefaultAdminEmail)
	}
	return true
}

// --- handlers ---------------------------------------------------------------

// OIDCConfig handles GET /auth/oidc/config — what the login page needs to
// render: whether SSO exists, its button label, and whether the password form
// is shown.
func (h *AuthHandler) OIDCConfig(w http.ResponseWriter, r *http.Request) {
	response.JSON(w, http.StatusOK, map[string]any{
		"enabled":        h.cfg.OIDC.Enabled,
		"display_name":   h.cfg.OIDC.DisplayName,
		"password_login": h.cfg.PasswordLogin,
	})
}

// OIDCLogin handles GET /auth/oidc/login?next=/path — starts the code flow.
func (h *AuthHandler) OIDCLogin(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.OIDC.Enabled {
		response.Error(w, http.StatusNotFound, "OIDC login is not enabled")
		return
	}
	_, oauthCfg, err := h.oidc.get(r.Context())
	if err != nil {
		slog.Error("oidc: provider unavailable", "err", err)
		h.oidcFail(w, r, "oidc_provider", "", err)
		return
	}
	st := oidcState{
		State:    randomToken(),
		Nonce:    randomToken(),
		Verifier: oauth2.GenerateVerifier(),
		Next:     safeNext(r.URL.Query().Get("next")),
		Exp:      time.Now().Add(oidcStateTTL).Unix(),
	}
	cookie, err := signState(h.jwtMgr.SharedSecret(), st)
	if err != nil {
		h.oidcFail(w, r, "oidc_state", "", err)
		return
	}
	// Lax, not Strict: the callback arrives as a top-level navigation from the
	// provider (cross-site), which Strict cookies would not accompany.
	http.SetCookie(w, &http.Cookie{
		Name:     oidcStateCookie,
		Value:    cookie,
		Path:     "/api/v1/auth/oidc",
		MaxAge:   int(oidcStateTTL.Seconds()),
		HttpOnly: true,
		Secure:   r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, oauthCfg.AuthCodeURL(st.State, oidc.Nonce(st.Nonce), oauth2.S256ChallengeOption(st.Verifier)), http.StatusFound)
}

// OIDCCallback handles GET /auth/oidc/callback?code=&state= — finishes the
// flow: state, code exchange (PKCE), ID token (signature, issuer, audience,
// expiry, nonce), claims, provisioning, session cookie.
func (h *AuthHandler) OIDCCallback(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.OIDC.Enabled {
		response.Error(w, http.StatusNotFound, "OIDC login is not enabled")
		return
	}
	q := r.URL.Query()
	c, err := r.Cookie(oidcStateCookie)
	if err != nil {
		h.oidcFail(w, r, "oidc_state", "", errors.New("missing state cookie"))
		return
	}
	http.SetCookie(w, &http.Cookie{Name: oidcStateCookie, Value: "", Path: "/api/v1/auth/oidc", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	st, err := verifyState(h.jwtMgr.SharedSecret(), c.Value, time.Now())
	if err != nil || q.Get("state") == "" || q.Get("state") != st.State {
		h.oidcFail(w, r, "oidc_state", "", fmt.Errorf("state check failed: %v", err))
		return
	}
	if e := q.Get("error"); e != "" {
		h.oidcFail(w, r, "oidc_denied", "", fmt.Errorf("provider returned %s: %s", e, q.Get("error_description")))
		return
	}
	provider, oauthCfg, err := h.oidc.get(r.Context())
	if err != nil {
		h.oidcFail(w, r, "oidc_provider", "", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	tok, err := oauthCfg.Exchange(ctx, q.Get("code"), oauth2.VerifierOption(st.Verifier))
	if err != nil {
		h.oidcFail(w, r, "oidc_exchange", "", err)
		return
	}
	rawIDToken, _ := tok.Extra("id_token").(string)
	if rawIDToken == "" {
		h.oidcFail(w, r, "oidc_token", "", errors.New("no id_token in token response"))
		return
	}
	idToken, err := provider.Verifier(&oidc.Config{ClientID: h.cfg.OIDC.ClientID}).Verify(ctx, rawIDToken)
	if err != nil {
		h.oidcFail(w, r, "oidc_token", "", err)
		return
	}
	if idToken.Nonce != st.Nonce {
		h.oidcFail(w, r, "oidc_token", "", errors.New("nonce mismatch"))
		return
	}
	var raw map[string]any
	if err := idToken.Claims(&raw); err != nil {
		h.oidcFail(w, r, "oidc_token", "", err)
		return
	}
	claims := extractClaims(raw, h.cfg.OIDC)
	if claims.Email == "" {
		h.oidcFail(w, r, "oidc_no_email", "", fmt.Errorf("claim %q missing", h.cfg.OIDC.EmailClaim))
		return
	}
	if claims.EmailVerified != nil && !*claims.EmailVerified {
		h.oidcFail(w, r, "oidc_email_unverified", claims.Email, errors.New("email_verified=false"))
		return
	}
	if !domainAllowed(claims.Email, h.cfg.OIDC.AllowedDomains) {
		h.oidcFail(w, r, "oidc_domain", claims.Email, errors.New("email domain not allowed"))
		return
	}

	user, err := h.provisionOIDCUser(r, claims)
	if err != nil {
		h.oidcFail(w, r, "oidc_provision", claims.Email, err)
		return
	}

	permissions, err := h.repo.GetPermissionsByRoleID(r.Context(), user.RoleID)
	if err != nil {
		h.oidcFail(w, r, "oidc_provision", claims.Email, err)
		return
	}
	matrix, err := h.buildPermissionMatrix(r.Context(), user.ID, permissions)
	if err != nil {
		h.oidcFail(w, r, "oidc_provision", claims.Email, err)
		return
	}
	clusterRoles, err := h.repo.ListUserClusterRoleNames(r.Context(), user.ID)
	if err != nil {
		h.oidcFail(w, r, "oidc_provision", claims.Email, err)
		return
	}
	token, err := h.jwtMgr.CreateToken(user.ID, user.Email, user.RoleName, matrix, clusterRoles, user.TokenVersion)
	if err != nil {
		h.oidcFail(w, r, "oidc_provision", claims.Email, err)
		return
	}
	h.setAuthCookie(w, r, token)
	h.writeAuditLog(r, "user.login.success", &user.ID, &user.Email, &user.ID, &user.Email, nil,
		jsonRaw(map[string]any{"method": "oidc", "issuer": h.cfg.OIDC.IssuerURL}))
	http.Redirect(w, r, st.Next, http.StatusFound)
}

// provisionOIDCUser finds or creates the user for the verified claims and,
// when SyncRoles is on and the token carries a groups claim, re-applies the
// group → role mapping and the per-cluster grants: the identity provider is
// the source of truth, so a group removed there is a role removed here on the
// next sign-in (no mapped group = DefaultRole). Without a groups claim
// (Google), roles stay as an admin set them.
func (h *AuthHandler) provisionOIDCUser(r *http.Request, claims oidcClaims) (*model.User, error) {
	ctx := r.Context()
	mapped := mapRole(claims.Groups, h.cfg.OIDC.RoleMapping)
	if mapped == "" {
		mapped = h.cfg.OIDC.DefaultRole
	}
	user, err := h.repo.GetUserByEmail(ctx, claims.Email)
	if err != nil {
		return nil, err
	}
	if user == nil {
		roleName := mapped
		role, err := h.repo.GetRoleByName(ctx, roleName)
		if err != nil || role == nil {
			return nil, fmt.Errorf("role %q not found", roleName)
		}
		name := claims.Name
		if name == "" {
			name = claims.Email
		}
		now := time.Now().UTC()
		user = &model.User{
			ID:         uuid.New().String(),
			Name:       name,
			Email:      claims.Email,
			RoleID:     role.ID,
			RoleName:   role.Name,
			AuthSource: model.AuthSourceOIDC,
			CreatedAt:  now,
			UpdatedAt:  now,
			// no password: this account can only sign in through the provider
		}
		if err := h.repo.CreateUser(ctx, user); err != nil {
			return nil, err
		}
		h.writeAuditLog(r, "user.account.provision", &user.ID, &user.Email, &user.ID, &user.Email, nil,
			jsonRaw(map[string]any{"method": "oidc", "role": role.Name, "groups": claims.Groups}))
	} else if h.cfg.OIDC.SyncRoles && claims.HasGroups && mapped != user.RoleName {
		role, err := h.repo.GetRoleByName(ctx, mapped)
		if err != nil || role == nil {
			return nil, fmt.Errorf("role %q not found", mapped)
		}
		before := jsonRaw(map[string]any{"role": user.RoleName})
		if err := h.repo.UpdateUserRole(ctx, user.ID, role.ID); err != nil {
			return nil, err
		}
		_ = h.repo.BumpTokenVersion(ctx, user.ID)
		if v, err := h.repo.GetTokenVersion(ctx, user.ID); err == nil {
			user.TokenVersion = v
		}
		user.RoleID, user.RoleName = role.ID, role.Name
		h.writeAuditLog(r, "user.role.sync", &user.ID, &user.Email, &user.ID, &user.Email, before,
			jsonRaw(map[string]any{"role": role.Name, "groups": claims.Groups}))
	}

	if h.cfg.OIDC.SyncRoles && claims.HasGroups {
		if err := h.syncClusterGrants(ctx, user.ID, clusterGrants(claims.Groups, h.cfg.OIDC.ClusterGroupPrefix)); err != nil {
			return nil, err
		}
	}
	return user, nil
}

func (h *AuthHandler) syncClusterGrants(ctx context.Context, userID string, want map[string]string) error {
	have, err := h.repo.ListUserClusterRoleNames(ctx, userID)
	if err != nil {
		return err
	}
	for clusterID, roleName := range want {
		if have[clusterID] == roleName {
			continue
		}
		role, err := h.repo.GetRoleByName(ctx, roleName)
		if err != nil || role == nil {
			slog.Warn("oidc: cluster group names unknown role", "cluster", clusterID, "role", roleName)
			continue
		}
		if err := h.repo.SetUserClusterRole(ctx, userID, clusterID, role.ID); err != nil {
			return err
		}
	}
	for clusterID := range have {
		if _, keep := want[clusterID]; !keep {
			if _, err := h.repo.DeleteUserClusterRole(ctx, userID, clusterID); err != nil {
				return err
			}
		}
	}
	return nil
}

// oidcFail records the failure and sends the browser back to the login page
// with a short error code (details stay in the log and the audit row).
func (h *AuthHandler) oidcFail(w http.ResponseWriter, r *http.Request, code, email string, err error) {
	slog.Warn("oidc: login failed", "code", code, "err", err)
	var target *string
	if email != "" {
		target = &email
	}
	h.writeAuditLog(r, "user.login.failed", nil, nil, nil, target, nil,
		jsonRaw(map[string]any{"method": "oidc", "reason": code}))
	http.Redirect(w, r, "/login?error="+url.QueryEscape(code), http.StatusFound)
}
