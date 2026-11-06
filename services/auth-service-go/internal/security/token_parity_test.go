package security

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// Fields of auth.TokenPayload this service's middleware leaves empty, and why
// that does no harm. A new field is compared by default.
var leftEmptyByTheMiddleware = map[string]string{
	// The middleware compares "tv" itself and no handler reads the field: a token
	// this service issues takes the version from the user's row.
	"TokenVersion": "checked in the middleware, read by no handler",
	// Only Impersonation reads it, and this service never acts on a cluster as the
	// caller. The investigator's token reaches this service only at the
	// token-version route, which reads the claim itself.
	"System": "this service never acts on a cluster as the caller",
}

// Both readers must see one token alike: a claim one of them forgets is a limit
// the other services keep and this one drops.
func TestAuthMiddlewareReadsATokenAsTheOtherServicesDo(t *testing.T) {
	mgr, err := NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(mgr.JWKS())
	}))
	defer jwks.Close()
	validator := auth.NewJWTValidator(auth.JWKSConfig{JWKSURL: jwks.URL, Issuer: "iss", Audience: "aud"})

	matrix := auth.PermissionMatrix{"*": {"admin.users.read"}, "a": {"resource.pod.read"}, "b": {"resource.pod.read"}, "c": {"*"}}
	roles := map[string]string{"a": "Read", "b": "Read", "c": "Admin"}
	scope := map[string][]string{"a": {"team-a", "team-b"}}
	signIn, err := mgr.CreateToken("u1", "someone@example.com", "Member", matrix, roles, scope, 3)
	if err != nil {
		t.Fatal(err)
	}
	reissued, err := mgr.CreateTokenAt("u1", "  someone@example.com ", "ADMIN", matrix, roles, nil, 3, time.Unix(1_700_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	apiKey, err := mgr.CreateAPIKeyToken("u1", "someone@example.com", "Member", auth.PermissionMatrix{"a": {"resource.pod.read"}}, map[string]string{"a": "Read"}, scope, 3, "key-1")
	if err != nil {
		t.Fatal(err)
	}
	investigator, err := mgr.CreateInvestigatorToken("a", "team-a", []string{"ai.tool.k8s_get_events"}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	empty, err := mgr.CreateToken("u2", "other@example.com", "", auth.PermissionMatrix{}, nil, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	withoutTimes := signed(t, mgr, jwt.MapClaims{"sub": "u3", "permissions": map[string]any{}, "iss": "iss", "aud": "aud", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix()})

	for name, c := range map[string]struct {
		token                string
		wantTV               int
		wantSystem           string
		mustHaveFilledFields []string
	}{
		"a sign-in":          {signIn, 3, "", []string{"UserID", "Email", "Role", "Perms", "Roles", "Namespaces", "AuthTime"}},
		"a refresh":          {reissued, 3, "", []string{"UserID", "Email", "Role", "Perms", "Roles", "AuthTime"}},
		"an API key's token": {apiKey, 3, "", []string{"UserID", "Email", "Perms", "Roles", "Namespaces", "APIKeyID"}},
		"the investigator":   {investigator, 0, auth.SystemInvestigator, []string{"UserID", "Email", "Perms", "Namespaces"}},
		"nothing granted":    {empty, 0, "", []string{"UserID", "Email", "Role", "AuthTime"}},
		"a token without tv": {withoutTimes, 0, "", []string{"UserID", "AuthTime"}},
	} {
		t.Run(name, func(t *testing.T) {
			theirs, err := validator.Validate(c.token)
			if err != nil {
				t.Fatalf("validator: %v", err)
			}
			ours := readWithMiddleware(t, mgr, c.token)
			if theirs.TokenVersion != c.wantTV || theirs.System != c.wantSystem {
				t.Errorf("validator read tv %d and sys %q, want %d and %q", theirs.TokenVersion, theirs.System, c.wantTV, c.wantSystem)
			}
			have, want := reflect.ValueOf(ours), reflect.ValueOf(theirs)
			for i := 0; i < have.NumField(); i++ {
				field := have.Type().Field(i).Name
				if _, skipped := leftEmptyByTheMiddleware[field]; skipped {
					if !have.Field(i).IsZero() {
						t.Errorf("%s is listed as left empty but holds %v: take it off the list", field, have.Field(i).Interface())
					}
					continue
				}
				if !reflect.DeepEqual(have.Field(i).Interface(), want.Field(i).Interface()) {
					t.Errorf("%s: middleware %#v, validator %#v", field, have.Field(i).Interface(), want.Field(i).Interface())
				}
			}
			for _, field := range c.mustHaveFilledFields {
				if have.FieldByName(field).IsZero() {
					t.Errorf("%s came back empty, so this case compares nothing there", field)
				}
			}
		})
	}
}

// A token from before the per-cluster format is refused by both, so neither
// service treats it as a token with no permissions.
func TestBothReadersRefuseAFlatPermissionClaim(t *testing.T) {
	mgr, err := NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(mgr.JWKS())
	}))
	defer jwks.Close()
	validator := auth.NewJWTValidator(auth.JWKSConfig{JWKSURL: jwks.URL, Issuer: "iss", Audience: "aud"})
	flat := signed(t, mgr, jwt.MapClaims{"sub": "u1", "permissions": []string{"*"}, "iss": "iss", "aud": "aud", "exp": time.Now().Add(time.Minute).Unix()})
	if _, err := validator.Validate(flat); err == nil {
		t.Error("validator accepted it")
	}
	if w := serveWithMiddleware(mgr, flat, func(auth.TokenPayload) {}); w.Code != http.StatusUnauthorized {
		t.Errorf("middleware answered %d, want 401", w.Code)
	}
}

func signed(t *testing.T, mgr *JWTManager, claims jwt.MapClaims) string {
	t.Helper()
	tok, err := mgr.sign(claims)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func serveWithMiddleware(mgr *JWTManager, token string, read func(auth.TokenPayload)) *httptest.ResponseRecorder {
	h := AuthMiddleware(mgr, nil, "")(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		if p, ok := auth.FromContext(r.Context()); ok {
			read(p)
		}
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func readWithMiddleware(t *testing.T, mgr *JWTManager, token string) auth.TokenPayload {
	t.Helper()
	var payload auth.TokenPayload
	if w := serveWithMiddleware(mgr, token, func(p auth.TokenPayload) { payload = p }); w.Code != http.StatusOK {
		t.Fatalf("middleware answered %d %s", w.Code, w.Body.String())
	}
	return payload
}
