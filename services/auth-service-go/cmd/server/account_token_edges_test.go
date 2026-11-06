package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const (
	bumpStatement   = "token_version = token_version + 1"
	globalHolders   = "role_id =  '7'  OR id IN (SELECT user_id FROM user_cluster_roles"
	insertAccount   = "INSERT INTO auth_users"
	clearedPassword = "SET password_hash =  ''"
	clusterKey      = "resource.*.read"
)

// raw calls any path, with no Authorization header when token is empty.
func (a *authAPI) raw(token, method, path, body string) *httptest.ResponseRecorder {
	a.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.router.ServeHTTP(w, req)
	return w
}

func jsonBody(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// noAccountYet makes every lookup by address find nothing.
func noAccountYet() pgRule { return pgRule{match: "WHERE u.email ="} }

// storedAccount makes every lookup by address find this account.
func storedAccount(email, roleName, passwordHash string) pgRule {
	return pgRule{
		match: "WHERE u.email =",
		oids:  []uint32{textOID, textOID, textOID, textOID, integerOID, textOID, textOID, integerOID, textOID, stampOID, stampOID, integerOID, stampOID, stampOID, stampOID, stampOID},
		rows:  [][]any{{"stored", "Stored", email, nil, roleCustom, roleName, passwordHash, 0, "password", pgNow(), pgNow(), 0, nil, nil, nil, nil}},
	}
}

func allowRegistration(c *config.Config) { c.AllowRegistration = true }

// newAccountAPI answers as an install where the address has no account yet and
// the forms' role exists.
func newAccountAPI(t *testing.T) *authAPI {
	t.Helper()
	return newAuthAPIWith(t, pendingRequest{owner: "requester"}, allowRegistration, noAccountYet(), roleRule(2, "Write", true))
}

// accountCreation is one way an address becomes an account.
type accountCreation struct {
	name      string
	call      func(api *authAPI, email string) *httptest.ResponseRecorder
	action    string
	madeIt    func(w *httptest.ResponseRecorder) bool
	refusedIt func(w *httptest.ResponseRecorder) bool
}

func bulkCounts(t *testing.T, w *httptest.ResponseRecorder) (created, refused int) {
	t.Helper()
	var body struct {
		Created []any `json:"created"`
		Errors  []any `json:"errors"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("bulk answer %s: %v", w.Body.String(), err)
	}
	return len(body.Created), len(body.Errors)
}

func accountCreations(t *testing.T) []accountCreation {
	account := func(email string) map[string]any {
		return map[string]any{"name": "Someone", "email": email, "password": testPassword, "role_id": 2}
	}
	refused400 := func(w *httptest.ResponseRecorder) bool { return w.Code == http.StatusBadRequest }
	return []accountCreation{
		{
			name: "self sign-up",
			call: func(api *authAPI, email string) *httptest.ResponseRecorder {
				return api.raw("", http.MethodPost, "/api/v1/auth/register", jsonBody(t, account(email)))
			},
			action:    "user.register",
			madeIt:    func(w *httptest.ResponseRecorder) bool { return w.Code == http.StatusOK },
			refusedIt: refused400,
		},
		{
			name: "an admin's form",
			call: func(api *authAPI, email string) *httptest.ResponseRecorder {
				return api.call(api.actor(globalAdmin, nil), http.MethodPost, "/admin/users", jsonBody(t, account(email)))
			},
			action:    "user.create",
			madeIt:    func(w *httptest.ResponseRecorder) bool { return w.Code == http.StatusCreated },
			refusedIt: refused400,
		},
		{
			name: "an admin's file",
			call: func(api *authAPI, email string) *httptest.ResponseRecorder {
				return api.call(api.actor(globalAdmin, nil), http.MethodPost, "/admin/users/bulk", jsonBody(t, map[string]any{"users": []any{account(email)}}))
			},
			action: "user.create",
			madeIt: func(w *httptest.ResponseRecorder) bool {
				created, refused := bulkCounts(t, w)
				return w.Code == http.StatusOK && created == 1 && refused == 0
			},
			refusedIt: func(w *httptest.ResponseRecorder) bool {
				created, refused := bulkCounts(t, w)
				return w.Code == http.StatusOK && created == 0 && refused == 1
			},
		},
	}
}

// The address is the user name a cluster sees, trimmed: a reserved name, or
// spaces around someone's address, would be that name there.
func TestNewAccountCannotBeNamedAsAClusterIdentity(t *testing.T) {
	for _, email := range []string{
		"system:anonymous@example.com",
		"system:serviceaccount:kube-system:default@example.com",
		"SYSTEM:node:one@example.com",
		"kubeast:investigator@example.com",
		"eks:node-manager@example.com",
		" someone@example.com",
		"someone@example.com ",
		"some one@example.com",
		"someone@example.com\n",
		"some\tone@example.com",
		"someone @example.com",
		"some\u0007one@example.com",
	} {
		for _, way := range accountCreations(t) {
			t.Run(way.name+"/"+email, func(t *testing.T) {
				api := newAccountAPI(t)
				w := way.call(api, email)
				if !way.refusedIt(w) {
					t.Errorf("%d %s, want it refused", w.Code, w.Body.String())
				}
				if api.db.ran(insertAccount) {
					t.Error("the account was made")
				}
				if rows := api.store.failures(way.action); len(rows) != 1 {
					t.Errorf("audit failures of %s = %+v, want one", way.action, rows)
				}
			})
		}
	}
}

func TestOrdinaryAddressesStillMakeAccounts(t *testing.T) {
	for _, email := range []string{
		"someone@example.com",
		"first.last+tag@sub.example.co.kr",
		"o'neil@example.com",
		"a_b-c@example.com",
		"홍길동@example.com",
		"someone@localhost",
		"Someone@Example.COM",
	} {
		for _, way := range accountCreations(t) {
			t.Run(way.name+"/"+email, func(t *testing.T) {
				api := newAccountAPI(t)
				w := way.call(api, email)
				if !way.madeIt(w) {
					t.Errorf("%d %s, want the account made", w.Code, w.Body.String())
				}
				if !api.db.ran(insertAccount) {
					t.Error("the account never reached the database")
				}
			})
		}
	}
}

// An address without "@" is still refused by the forms: the default admin's
// "admin" comes from the chart's setting, not through them.
func TestTheFormsStillWantAnAddress(t *testing.T) {
	for _, way := range accountCreations(t) {
		t.Run(way.name, func(t *testing.T) {
			api := newAccountAPI(t)
			if w := way.call(api, "admin"); !way.refusedIt(w) {
				t.Errorf("%d %s, want it refused", w.Code, w.Body.String())
			}
		})
	}
}

// Accounts that already exist are not read through the rule: their people still sign in.
func TestStoredAccountsKeepSigningIn(t *testing.T) {
	hash, err := security.HashPassword(testPassword, 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, email := range []string{"admin", "someone@example.com", "system:old@example.com", "kubeast:old@example.com", " spaced@example.com"} {
		t.Run(email, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, storedAccount(email, "Member", hash))
			w := api.raw("", http.MethodPost, "/api/v1/auth/login", jsonBody(t, map[string]string{"email": email, "password": testPassword}))
			if w.Code != http.StatusOK {
				t.Errorf("%d %s, want 200", w.Code, w.Body.String())
			}
		})
	}
}

// oidcProvider is a provider with discovery, keys and a token endpoint: enough
// for the real login and callback routes.
type oidcProvider struct {
	t      *testing.T
	srv    *httptest.Server
	keys   *security.JWTManager
	nonce  string
	claims map[string]any
}

func startOIDCProvider(t *testing.T) *oidcProvider {
	t.Helper()
	p := &oidcProvider{t: t}
	mux := http.NewServeMux()
	writeJSON := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{
			"issuer": p.srv.URL, "authorization_endpoint": p.srv.URL + "/auth", "token_endpoint": p.srv.URL + "/token",
			"jwks_uri": p.srv.URL + "/jwks", "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, p.keys.JWKS()) })
	mux.HandleFunc("/token", func(w http.ResponseWriter, _ *http.Request) {
		claims := jwt.MapClaims{"iss": p.srv.URL, "aud": "kubeast", "sub": "provider-subject", "nonce": p.nonce, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix()}
		for k, v := range p.claims {
			claims[k] = v
		}
		token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		token.Header["kid"] = p.keys.KeyID
		signed, err := token.SignedString(p.keys.PrivateKey)
		if err != nil {
			t.Error(err)
		}
		writeJSON(w, map[string]any{"access_token": "not-a-real-token", "token_type": "Bearer", "id_token": signed})
	})
	p.srv = httptest.NewServer(mux)
	t.Cleanup(p.srv.Close)
	keys, err := security.NewJWTManager(t.TempDir(), p.srv.URL, "kubeast", 5)
	if err != nil {
		t.Fatal(err)
	}
	p.keys = keys
	return p
}

func (p *oidcProvider) settings(c *config.Config) {
	c.AuthCookieName = "kubeast.token"
	c.OIDC = config.OIDCConfig{
		Enabled: true, IssuerURL: p.srv.URL, ClientID: "kubeast", ClientSecret: "not-a-real-secret",
		RedirectURL: "http://kubeast.test/api/v1/auth/oidc/callback", Scopes: []string{"openid", "email"},
		EmailClaim: "email", NameClaim: "name", GroupsClaim: "groups",
		DefaultRole: "Member", SyncRoles: true, ClusterGroupPrefix: "kubeast:cluster:",
	}
}

// signIn walks the login and the callback and answers where the browser ends up
// and the session token, if one was set.
func (p *oidcProvider) signIn(api *authAPI, claims map[string]any) (string, jwt.MapClaims) {
	p.t.Helper()
	login := api.raw("", http.MethodGet, "/api/v1/auth/oidc/login?next=/", "")
	if login.Code != http.StatusFound {
		p.t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	to, err := url.Parse(login.Header().Get("Location"))
	if err != nil {
		p.t.Fatal(err)
	}
	p.nonce, p.claims = to.Query().Get("nonce"), claims
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/callback?code=not-a-real-code&state="+url.QueryEscape(to.Query().Get("state")), nil)
	for _, c := range login.Result().Cookies() {
		req.AddCookie(c)
	}
	w := httptest.NewRecorder()
	api.router.ServeHTTP(w, req)
	if w.Code != http.StatusFound {
		p.t.Fatalf("callback: %d %s", w.Code, w.Body.String())
	}
	var session jwt.MapClaims
	for _, c := range w.Result().Cookies() {
		if c.Name == "kubeast.token" && c.Value != "" {
			if session, err = api.mgr.ValidateToken(c.Value); err != nil {
				p.t.Fatal(err)
			}
		}
	}
	return w.Header().Get("Location"), session
}

func TestProviderCannotMakeAnAccountNamedAsAClusterIdentity(t *testing.T) {
	for _, name := range []string{"system:kube-controller-manager", "system:anonymous", "kubeast:cache", "eks:node-manager", "some one@example.com"} {
		t.Run(name, func(t *testing.T) {
			p := startOIDCProvider(t)
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, p.settings, noAccountYet())
			to, session := p.signIn(api, map[string]any{"email": name, "email_verified": true})
			if to != "/login?error=oidc_email_invalid" {
				t.Errorf("sent to %q, want the login page with oidc_email_invalid", to)
			}
			if session != nil {
				t.Errorf("a session was set: %v", session)
			}
			if api.db.ran(insertAccount) {
				t.Error("the account was made")
			}
		})
	}
}

// A provider may name people by a claim that is not an address; those keep working.
func TestProviderStillMakesOrdinaryAccounts(t *testing.T) {
	for _, name := range []string{"someone@example.com", "someone", "first.last@example.co.kr"} {
		t.Run(name, func(t *testing.T) {
			p := startOIDCProvider(t)
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, p.settings, noAccountYet())
			to, session := p.signIn(api, map[string]any{"email": name, "email_verified": true})
			if to != "/" || session == nil {
				t.Fatalf("sent to %q with session %v, want a session", to, session)
			}
			if session["email"] != name {
				t.Errorf("session name %v, want %s", session["email"], name)
			}
			if !api.db.ran(insertAccount) {
				t.Error("the account never reached the database")
			}
		})
	}
}

func TestProviderStillSignsInAStoredAccountWhateverItsName(t *testing.T) {
	p := startOIDCProvider(t)
	api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, p.settings, storedAccount("system:old", "Member", ""))
	to, session := p.signIn(api, map[string]any{"email": "system:old", "email_verified": true})
	if to != "/" || session == nil {
		t.Fatalf("sent to %q with session %v, want a session", to, session)
	}
}

// A self sign-up proves nothing about the address and still waits for approval,
// so when the address's owner signs in, what its maker holds must end there.
func TestOwnerSigningInEndsWhatASelfSignUpHeld(t *testing.T) {
	p := startOIDCProvider(t)
	currentVersion := pgRule{match: "SELECT token_version FROM auth_users WHERE id", oids: []uint32{integerOID}, rows: [][]any{{4}}}
	api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, p.settings, currentVersion, storedAccount("someone@example.com", "Pending", "stored-hash"))
	_, session := p.signIn(api, map[string]any{"email": "someone@example.com", "email_verified": true})
	if !api.db.ran(clearedPassword) {
		t.Error("the password set at sign-up still works")
	}
	if !api.db.ran(bumpStatement) {
		t.Error("the sign-up's tokens still work")
	}
	if session == nil || session["tv"] != float64(4) {
		t.Errorf("session %v, want the version after the change (4)", session)
	}
	if rows := api.store.successes("user.account.link"); len(rows) != 1 {
		t.Errorf("user.account.link rows = %+v, want one", rows)
	}
}

// Anyone an admin approved or made keeps the password, the default admin too:
// it is the way back when the provider is down.
func TestApprovedAccountKeepsItsPasswordWhenItsOwnerSignsIn(t *testing.T) {
	for _, role := range []string{"Member", "Admin", "Auditor"} {
		t.Run(role, func(t *testing.T) {
			p := startOIDCProvider(t)
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, p.settings, storedAccount("someone@example.com", role, "stored-hash"))
			_, session := p.signIn(api, map[string]any{"email": "someone@example.com", "email_verified": true})
			if session == nil {
				t.Fatal("no session")
			}
			if api.db.ran(clearedPassword) {
				t.Error("the password was taken away")
			}
			if api.db.ran(bumpStatement) {
				t.Error("the account's other sessions were ended")
			}
		})
	}
}

// Other devices keep a token with the old grants; the token this sign-in gets is
// made after the change and must carry the new version.
func TestProviderGroupsEndOldTokensWhenAGrantIsLost(t *testing.T) {
	currentVersion := pgRule{match: "SELECT token_version FROM auth_users WHERE id", oids: []uint32{integerOID}, rows: [][]any{{9}}}
	writeRole := pgRule{match: "FROM roles WHERE name", oids: []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID}, rows: [][]any{{2, "Write", "", true, pgNow(), pgNow()}}}
	haveGrants := func(rows ...[]any) pgRule {
		return pgRule{match: "SELECT ucr.cluster_id, ro.name", oids: []uint32{textOID, textOID}, rows: rows}
	}
	for _, c := range []struct {
		name    string
		have    [][]any
		groups  []any
		ended   bool
		version float64
	}{
		{"a group gone at the provider", [][]any{{"c", "Write"}}, []any{}, true, 9},
		{"a grant replaced by another", [][]any{{"c", "Admin"}}, []any{"kubeast:cluster:c:Write"}, true, 9},
		{"a new grant only", nil, []any{"kubeast:cluster:c:Write"}, false, 0},
		{"nothing changed", [][]any{{"c", "Write"}}, []any{"kubeast:cluster:c:Write"}, false, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := startOIDCProvider(t)
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, p.settings, currentVersion, writeRole, haveGrants(c.have...), storedAccount("someone@example.com", "Member", ""))
			_, session := p.signIn(api, map[string]any{"email": "someone@example.com", "email_verified": true, "groups": c.groups})
			if session == nil {
				t.Fatal("no session")
			}
			if got := api.db.ran(bumpStatement); got != c.ended {
				t.Errorf("old tokens ended = %v, want %v", got, c.ended)
			}
			if session["tv"] != c.version {
				t.Errorf("the new session's version = %v, want %v", session["tv"], c.version)
			}
		})
	}
}

// The token holds a grant's whole list and the role's name there, and of a global
// role only "*" and admin.*: holders lose a session only when it could still use
// something the role no longer gives.
func TestRoleEditEndsSessionsOnlyWhereTheyHoldSomethingLost(t *testing.T) {
	for _, c := range []struct {
		name         string
		stored       string
		before       []string
		rename       string
		after        []string
		grantHolders bool
		allHolders   bool
	}{
		{"a cluster key taken away", "custom", []string{"menu.dashboard", clusterKey}, "custom", []string{"menu.dashboard"}, true, false},
		{"a wildcard narrowed", "custom", []string{"menu.*"}, "custom", []string{"menu.dashboard"}, true, false},
		{"a middle wildcard narrowed", "custom", []string{"resource.*.*"}, "custom", []string{"resource.*.read"}, true, false},
		{"every key taken away", "custom", []string{clusterKey}, "custom", []string{}, true, false},
		{"an admin key taken away", "custom", []string{"admin.audit.read", clusterKey}, "custom", []string{clusterKey}, true, true},
		{"the superuser key taken away", "custom", []string{"*"}, "custom", []string{"resource.*.*"}, true, true},
		{"an admin wildcard narrowed", "custom", []string{"admin.*"}, "custom", []string{"admin.audit.read"}, true, true},
		{"a rename to another group", "custom", []string{clusterKey}, "renamed", []string{clusterKey}, true, false},
		{"a key added", "custom", []string{"menu.dashboard"}, "custom", []string{"menu.dashboard", clusterKey}, false, false},
		{"a wildcard widened", "custom", []string{"menu.dashboard"}, "custom", []string{"menu.*"}, false, false},
		{"the description alone", "custom", []string{"menu.dashboard", clusterKey}, "custom", []string{"menu.dashboard", clusterKey}, false, false},
		{"the same keys in another order", "custom", []string{"menu.dashboard", clusterKey}, "custom", []string{clusterKey, "menu.dashboard"}, false, false},
		{"a key swapped for one that covers it", "custom", []string{clusterKey}, "custom", []string{"resource.*.*"}, false, false},
		{"a rename in capitals, the same group", "custom", []string{clusterKey}, "CUSTOM", []string{clusterKey}, false, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			rules := append([]pgRule{permsRule(roleCustom, c.before...), roleRule(roleCustom, c.stored, false)}, roleNameRules()...)
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, rules...)
			body := jsonBody(t, map[string]any{"name": c.rename, "description": "edited", "permissions": c.after})
			w := api.call(api.actor(globalAdmin, nil), http.MethodPut, fmt.Sprintf("/admin/roles/%d", roleCustom), body)
			if w.Code != http.StatusOK {
				t.Fatalf("%d %s, want 200", w.Code, w.Body.String())
			}
			if got := api.db.ran(bumpStatement); got != c.grantHolders {
				t.Errorf("sessions ended = %v, want %v", got, c.grantHolders)
			}
			if got := api.db.ran(globalHolders); got != c.allHolders {
				t.Errorf("sessions of global holders ended = %v, want %v", got, c.allHolders)
			}
		})
	}
}

// A role's fixed keys cannot change, so a description edit of a built-in ends nothing.
func TestSystemRoleDescriptionEditEndsNoSession(t *testing.T) {
	rules := append([]pgRule{permsRule(roleCustom, clusterKey), roleRule(roleCustom, "Read", true)}, roleNameRules()...)
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, rules...)
	body := jsonBody(t, map[string]any{"name": "Read", "description": "edited", "permissions": []string{clusterKey}})
	w := api.call(api.actor(globalAdmin, nil), http.MethodPut, fmt.Sprintf("/admin/roles/%d", roleCustom), body)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s, want 200", w.Code, w.Body.String())
	}
	if api.db.ran(bumpStatement) {
		t.Error("a session was ended")
	}
}

func TestRoleListNeedsASignIn(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"})
	if w := api.raw("", http.MethodGet, "/api/v1/auth/roles", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("no token: %d %s, want 401", w.Code, w.Body.String())
	}
	if api.db.ran("FROM roles ORDER BY id") {
		t.Error("no token: the roles were read")
	}
	for name, token := range map[string]string{"session": api.sessionToken(), "API key": api.keyToken()} {
		w := api.call(token, http.MethodGet, "/roles", "")
		if w.Code != http.StatusOK || !strings.HasPrefix(strings.TrimSpace(w.Body.String()), "[") {
			t.Errorf("%s: %d %s, want the list", name, w.Code, w.Body.String())
		}
	}
}

// The pages before a sign-in read these; they stay open.
func TestWhatTheSignInPageReadsStaysOpen(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"})
	for _, path := range []string{"/organizations?type=team", "/oidc/config", "/jwks.json"} {
		if w := api.raw("", http.MethodGet, "/api/v1/auth"+path, ""); w.Code != http.StatusOK {
			t.Errorf("%s: %d %s, want 200", path, w.Code, w.Body.String())
		}
	}
}

func TestSetupRolloutStatusFollowsTheWizardsPermission(t *testing.T) {
	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer health.Close()
	withHealth := func(c *config.Config) { c.K8sServiceHealthURL = health.URL }
	api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, withHealth)

	if w := api.raw("", http.MethodGet, "/api/v1/auth/setup/rollout-status", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("no token: %d %s, want 401", w.Code, w.Body.String())
	}
	for name, token := range map[string]string{
		"a signed-in reader": api.sessionToken(),
		"an API key":         api.keyToken(),
		"another admin key":  api.actor(auth.PermissionMatrix{"*": {"admin.users.update"}}, nil),
		"a cluster's admin":  api.actor(auth.PermissionMatrix{"c": {"*"}}, nil),
	} {
		api.store.rows = nil
		w := api.call(token, http.MethodGet, "/setup/rollout-status", "")
		if w.Code != http.StatusForbidden {
			t.Errorf("%s: %d %s, want 403", name, w.Code, w.Body.String())
		}
		if rows := api.store.failures("admin.access.denied"); len(rows) != 1 {
			t.Errorf("%s: denied rows = %+v, want one", name, rows)
		}
	}
	for name, perms := range map[string]auth.PermissionMatrix{
		"the wizard's permission": {"*": {auth.PermClustersCreate}},
		"admin.clusters.*":        {"*": {"admin.clusters.*"}},
		"a global admin":          globalAdmin,
	} {
		w := api.call(api.actor(perms, nil), http.MethodGet, "/setup/rollout-status", "")
		var body struct {
			Ready bool `json:"ready"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != http.StatusOK || !body.Ready {
			t.Errorf("%s: %d %s, want 200 and ready", name, w.Code, w.Body.String())
		}
	}
}

func TestClusterSwitchRowComesFromASignedInPerson(t *testing.T) {
	const body = `{"previous_cluster":"a","new_cluster":"b"}`
	api := newAuthAPI(t, pendingRequest{owner: "requester"})
	w := api.raw(api.keyToken(), http.MethodPost, "/api/v1/audit/cluster-switch", body)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "API key") {
		t.Errorf("key token: %d %s, want 403 naming the API key", w.Code, w.Body.String())
	}
	if rows := api.store.successes("user.cluster.switch"); len(rows) != 0 {
		t.Errorf("key token: a switch was recorded under the owner: %+v", rows)
	}
	if rows := api.store.failures("user.cluster.switch"); len(rows) != 1 || !strings.Contains(string(rows[0].After), "key-1") {
		t.Errorf("key token: failure rows = %+v, want one naming the key", rows)
	}

	if w := api.raw(api.sessionToken(), http.MethodPost, "/api/v1/audit/cluster-switch", body); w.Code != http.StatusNoContent {
		t.Errorf("session: %d %s, want 204", w.Code, w.Body.String())
	}
	if rows := api.store.successes("user.cluster.switch"); len(rows) != 1 {
		t.Errorf("session: rows = %+v, want one", rows)
	}
}
