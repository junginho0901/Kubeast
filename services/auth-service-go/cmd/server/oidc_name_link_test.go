package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
)

// linkProvider is a provider with discovery, keys and a token endpoint, and the real login and callback routes on a
// fake database holding one account.
type linkProvider struct {
	t      *testing.T
	srv    *httptest.Server
	keys   *security.JWTManager
	nonce  string
	claims map[string]any
	db     *fakePG
	store  *recordedAudit
	mgr    *security.JWTManager
	router http.Handler
}

func storedLinkAccount(email, source string, roleName string) pgRule {
	return storedLinkAccountHolding("not-a-real-hash", email, source, roleName)
}

func storedLinkAccountHolding(passwordHash, email, source, roleName string) pgRule {
	return pgRule{
		match: "WHERE u.email =",
		oids:  []uint32{textOID, textOID, textOID, textOID, integerOID, textOID, textOID, integerOID, textOID, stampOID, stampOID, integerOID, stampOID, stampOID, stampOID, stampOID},
		rows:  [][]any{{"stored", "Stored", email, nil, roleAdmin, roleName, passwordHash, 0, source, pgNow(), pgNow(), 0, nil, nil, nil, nil}},
	}
}

func startLinkProvider(t *testing.T, settings func(*config.OIDCConfig), rules ...pgRule) *linkProvider {
	t.Helper()
	p := &linkProvider{t: t, store: &recordedAudit{}}
	writeJSON := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux := http.NewServeMux()
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
	var err error
	if p.keys, err = security.NewJWTManager(t.TempDir(), p.srv.URL, "kubeast", 5); err != nil {
		t.Fatal(err)
	}
	if p.mgr, err = security.NewJWTManager(t.TempDir(), "iss", "aud", 5); err != nil {
		t.Fatal(err)
	}
	db, pool := startFakePG(t, append(rules,
		sessionState(0),
		pgRule{match: "SELECT token_version FROM auth_users", oids: []uint32{integerOID}, rows: [][]any{{0}}},
		pgRule{match: "FROM roles WHERE name",
			oids: []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID},
			rows: [][]any{{roleMember, "Member", "", "t", pgNow(), pgNow()}}},
	)...)
	p.db = db
	oidc := config.OIDCConfig{
		Enabled: true, IssuerURL: p.srv.URL, ClientID: "kubeast", ClientSecret: "not-a-real-secret",
		RedirectURL: "http://kubeast.test/api/v1/auth/oidc/callback", Scopes: []string{"openid", "email"},
		EmailClaim: "email", NameClaim: "name", GroupsClaim: "groups", DefaultRole: "Member", ClusterGroupPrefix: "kubeast:cluster:",
	}
	if settings != nil {
		settings(&oidc)
	}
	h := handler.NewAuthHandler(repository.New(pool), p.mgr, config.Config{AuthCookieName: "kubeast.token", OIDC: oidc, JWTExpiresMinutes: 5}, p.store)
	r := chi.NewRouter()
	r.Get("/oidc/login", h.OIDCLogin)
	r.Get("/oidc/callback", h.OIDCCallback)
	p.router = r
	return p
}

// signIn walks the login and the callback; where the browser ends up, and whether a session was set.
func (p *linkProvider) signIn(claims map[string]any) (string, bool) {
	p.t.Helper()
	login := httptest.NewRecorder()
	p.router.ServeHTTP(login, httptest.NewRequest(http.MethodGet, "/oidc/login?next=/", nil))
	if login.Code != http.StatusFound {
		p.t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	to, err := url.Parse(login.Header().Get("Location"))
	if err != nil {
		p.t.Fatal(err)
	}
	p.nonce, p.claims = to.Query().Get("nonce"), claims
	req := httptest.NewRequest(http.MethodGet, "/oidc/callback?code=not-a-real-code&state="+url.QueryEscape(to.Query().Get("state")), nil)
	for _, c := range login.Result().Cookies() {
		req.AddCookie(c)
	}
	w := httptest.NewRecorder()
	p.router.ServeHTTP(w, req)
	if w.Code != http.StatusFound {
		p.t.Fatalf("callback: %d %s", w.Code, w.Body.String())
	}
	session := false
	for _, c := range w.Result().Cookies() {
		session = session || (c.Name == "kubeast.token" && c.Value != "")
	}
	return w.Header().Get("Location"), session
}

func usernameClaim(c *config.OIDCConfig) { c.EmailClaim = "preferred_username" }

const linkConflict = "/login?error=oidc_account_conflict"

func TestProviderNameThatIsNoAddressDoesNotReachAPasswordAccount(t *testing.T) {
	for _, c := range []struct {
		name     string
		settings func(*config.OIDCConfig)
		claims   map[string]any
	}{
		{"a username claim", usernameClaim, map[string]any{"preferred_username": "admin"}},
		{"the email claim holding a plain name", nil, map[string]any{"email": "admin"}},
		{"the name in another case", usernameClaim, map[string]any{"preferred_username": " ADMIN "}},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := startLinkProvider(t, c.settings, storedLinkAccount("admin", "password", "Admin"))
			to, session := p.signIn(c.claims)
			if to != linkConflict || session {
				t.Errorf("sent to %q, session %v, want %q and no session", to, session, linkConflict)
			}
			if rows := p.store.failures("user.login.failed"); len(rows) != 1 || rows[0].Error != "oidc_account_conflict" {
				t.Errorf("failure rows = %+v", rows)
			}
		})
	}
}

func TestProviderKeepsSigningInTheAccountsItShouldReach(t *testing.T) {
	for _, c := range []struct {
		name     string
		settings func(*config.OIDCConfig)
		claims   map[string]any
		account  pgRule
	}{
		{"a username account the provider made", usernameClaim, map[string]any{"preferred_username": "alice"}, storedLinkAccountHolding("", "alice", "oidc", "Member")},
		{"a username account the provider made that an admin later gave a password", usernameClaim, map[string]any{"preferred_username": "alice"}, storedLinkAccount("alice", "oidc", "Member")},
		{"a stored name holding no password", usernameClaim, map[string]any{"preferred_username": "alice"}, storedLinkAccountHolding("", "alice", "password", "Member")},
		{"an address in a username claim on a password account", usernameClaim, map[string]any{"preferred_username": "alice@example.com"}, storedLinkAccount("alice@example.com", "password", "Member")},
		{"an address on a password account", nil, map[string]any{"email": "alice@example.com", "email_verified": true}, storedLinkAccount("alice@example.com", "password", "Member")},
		{"an address on an account the provider made", nil, map[string]any{"email": "alice@example.com"}, storedLinkAccount("alice@example.com", "oidc", "Member")},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := startLinkProvider(t, c.settings, c.account)
			to, session := p.signIn(c.claims)
			if to != "/" || !session {
				t.Errorf("sent to %q, session %v, want / with a session", to, session)
			}
		})
	}
}

func TestProviderStillMakesAnAccountForANameNotTaken(t *testing.T) {
	p := startLinkProvider(t, usernameClaim, pgRule{match: "WHERE u.email ="})
	to, session := p.signIn(map[string]any{"preferred_username": "newcomer"})
	if to != "/" || !session || !p.db.ran("INSERT INTO auth_users") {
		t.Errorf("sent to %q, session %v, account made %v", to, session, p.db.ran("INSERT INTO auth_users"))
	}
}

func roleFromGroups(c *config.OIDCConfig) {
	c.SyncRoles = true
	c.RoleMapping = map[string]string{"engineering": "Member"}
}

func TestSignInWhoseRoleSyncCannotEndOldTokensFails(t *testing.T) {
	p := startLinkProvider(t, roleFromGroups, storedLinkAccount("alice@example.com", "oidc", "Admin"))
	p.db.failOn(endsTokens)
	to, session := p.signIn(map[string]any{"email": "alice@example.com", "groups": []any{"engineering"}})
	if to != "/login?error=oidc_provision" || session {
		t.Errorf("sent to %q, session %v, want the provisioning error and no session", to, session)
	}
}

func TestSignInWithARoleSyncEndsOldTokensAndGoesOn(t *testing.T) {
	p := startLinkProvider(t, roleFromGroups, storedLinkAccount("alice@example.com", "oidc", "Admin"))
	to, session := p.signIn(map[string]any{"email": "alice@example.com", "groups": []any{"engineering"}})
	if to != "/" || !session || !p.db.ran(endsTokens) {
		t.Errorf("sent to %q, session %v, tokens ended %v", to, session, p.db.ran(endsTokens))
	}
}
