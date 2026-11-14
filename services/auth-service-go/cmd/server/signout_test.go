package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// cookieAPI is newAuthAPI with the session cookie named, as the chart names it.
func cookieAPI(t *testing.T, extra ...pgRule) *authAPI {
	t.Helper()
	return newAuthAPIWith(t, pendingRequest{owner: "requester"}, func(c *config.Config) { c.AuthCookieName = "kubeast.token" }, extra...)
}

// signInAt is owner's token of the sign-in at signedIn, as a sign-in and its refreshes issue it.
func (a *authAPI) signInAt(signedIn time.Time) string {
	a.t.Helper()
	tok, err := a.mgr.CreateTokenAt("owner", "owner@example.com", "Member", auth.PermissionMatrix{"c": {readPerm}}, map[string]string{"c": "Read"}, nil, 0, signedIn)
	if err != nil {
		a.t.Fatal(err)
	}
	return tok
}

// expiredSignInAt is owner's token of the sign-in at signedIn that expired a minute ago, signed with key.
func expiredSignInAt(t *testing.T, key *security.JWTManager, signedIn time.Time) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "owner", "email": "owner@example.com", "role": "Member",
		"permissions": map[string]any{"c": []string{readPerm}}, "tv": 0,
		"auth_time": signedIn.Unix(), "iss": "iss", "aud": "aud",
		"iat": time.Now().Add(-10 * time.Minute).Unix(), "exp": time.Now().Add(-time.Minute).Unix(),
	})
	tok.Header["kid"] = key.KeyID
	s, err := tok.SignedString(key.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func clearsTheCookie(w *httptest.ResponseRecorder) bool {
	for _, c := range w.Result().Cookies() {
		if c.Name == "kubeast.token" && c.MaxAge < 0 {
			return true
		}
	}
	return false
}

func TestSigningOutEndsTheSignInOnTheServer(t *testing.T) {
	api := cookieAPI(t)
	signedIn := time.Now().Add(-time.Hour).Truncate(time.Second)
	w := api.call(api.signInAt(signedIn), http.MethodPost, "/logout", "")
	if w.Code != http.StatusOK || !clearsTheCookie(w) {
		t.Fatalf("logout: %d %s, cookie cleared %v", w.Code, w.Body.String(), clearsTheCookie(w))
	}
	insert := api.db.statement("INSERT INTO ended_sign_ins")
	if !strings.Contains(insert, "'owner'") || !strings.Contains(insert, strconv.FormatInt(signedIn.Unix(), 10)) {
		t.Fatalf("the sign-in's end: %q", insert)
	}
	if !strings.Contains(insert, "ON CONFLICT (user_id, auth_time) DO NOTHING") {
		t.Errorf("signing out again must be no change: %q", insert)
	}
	rows := api.store.successes("user.logout")
	if len(rows) != 1 || rows[0].ActorUserID != "owner" || !strings.Contains(string(rows[0].After), signedIn.UTC().Format(time.RFC3339)) {
		t.Fatalf("user.logout rows = %+v", rows)
	}
}

// A tab whose token expired still holds live connections of its sign-in: signing out there ends them too.
func TestSigningOutWithAnExpiredTokenStillEndsItsSignIn(t *testing.T) {
	api := cookieAPI(t)
	signedIn := time.Now().Add(-3 * time.Hour).Truncate(time.Second)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: "kubeast.token", Value: expiredSignInAt(t, api.mgr, signedIn)})
	w := httptest.NewRecorder()
	api.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !clearsTheCookie(w) {
		t.Fatalf("logout: %d %s", w.Code, w.Body.String())
	}
	if insert := api.db.statement("INSERT INTO ended_sign_ins"); !strings.Contains(insert, strconv.FormatInt(signedIn.Unix(), 10)) {
		t.Fatalf("the sign-in's end: %q", insert)
	}
}

func TestSigningOutEndsNoSignInForAKeysTokenOrAnotherKeysSignature(t *testing.T) {
	api := cookieAPI(t)
	if w := api.call(api.keyToken(), http.MethodPost, "/logout", ""); w.Code != http.StatusOK {
		t.Fatalf("key token: %d %s", w.Code, w.Body.String())
	}
	if rows := api.store.successes("user.logout"); len(rows) != 1 || len(rows[0].After) != 0 {
		t.Fatalf("a key's token is no sign-in, its row names no sign-in: %+v", rows)
	}
	other, err := security.NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	signedIn := time.Now().Add(-time.Hour)
	for name, tok := range map[string]string{"another key": expiredSignInAt(t, other, signedIn), "no token": "not-a-token"} {
		if w := api.call(tok, http.MethodPost, "/logout", ""); w.Code != http.StatusOK {
			t.Errorf("%s: %d", name, w.Code)
		}
	}
	if api.db.ran("ended_sign_ins") {
		t.Fatalf("ended a sign-in: %q", api.db.statement("ended_sign_ins"))
	}
	if rows := api.store.successes("user.logout"); len(rows) != 1 {
		t.Fatalf("rows for a signature that is not ours: %+v", rows)
	}
}

// Refusing would keep the person signed in on that browser while the database is down.
func TestASignOutTheDatabaseCouldNotStoreStillSignsTheBrowserOut(t *testing.T) {
	api := cookieAPI(t)
	api.db.failOn("INSERT INTO ended_sign_ins")
	w := api.call(api.signInAt(time.Now().Add(-time.Hour)), http.MethodPost, "/logout", "")
	if w.Code != http.StatusOK || !clearsTheCookie(w) {
		t.Fatalf("logout: %d %s, cookie cleared %v", w.Code, w.Body.String(), clearsTheCookie(w))
	}
	rows := api.store.failures("user.logout")
	if len(rows) != 1 || rows[0].Error != "sign_in_end_not_stored" {
		t.Fatalf("user.logout failure rows = %+v", rows)
	}
	if ok := api.store.successes("user.logout"); len(ok) != 0 {
		t.Fatalf("a success row for an end not stored: %+v", ok)
	}
}

// A user deleted meanwhile has nothing left to end: every token of theirs is refused already.
func TestASignOutOfAUserWhoIsGoneEndsNothingAndIsNoFailure(t *testing.T) {
	api := cookieAPI(t)
	api.db.failOnCode("INSERT INTO ended_sign_ins", "23503")
	w := api.call(api.signInAt(time.Now().Add(-time.Hour)), http.MethodPost, "/logout", "")
	if w.Code != http.StatusOK || !clearsTheCookie(w) {
		t.Fatalf("logout: %d %s", w.Code, w.Body.String())
	}
	if rows := api.store.failures("user.logout"); len(rows) != 0 {
		t.Fatalf("failure rows = %+v", rows)
	}
	if rows := api.store.successes("user.logout"); len(rows) != 1 {
		t.Fatalf("user.logout rows = %+v", rows)
	}
}

func TestRefreshRefusesASignedOutSignInAsAnExpiredSession(t *testing.T) {
	signedIn := time.Now().Add(-time.Hour).Truncate(time.Second)
	api := cookieAPI(t, sessionState(0, signedIn.Unix()))
	w := api.call(api.signInAt(signedIn), http.MethodPost, "/refresh", "")
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "Session expired; sign in again") || !clearsTheCookie(w) {
		t.Fatalf("refresh of the signed-out sign-in: %d %s, cookie cleared %v", w.Code, w.Body.String(), clearsTheCookie(w))
	}
	rows := api.store.failures("user.token.refresh")
	if len(rows) != 1 || rows[0].Error != "session_signed_out" || rows[0].ActorUserID != "owner" {
		t.Fatalf("user.token.refresh failure rows = %+v", rows)
	}
	var after map[string]any
	if err := json.Unmarshal(rows[0].After, &after); err != nil || after["reason"] != "session_signed_out" || after["auth_time"] != signedIn.UTC().Format(time.RFC3339) {
		t.Fatalf("row after = %s (%v)", rows[0].After, err)
	}

	// The same person's other sign-in goes on.
	if w := api.call(api.signInAt(signedIn.Add(time.Second)), http.MethodPost, "/refresh", ""); w.Code != http.StatusOK {
		t.Fatalf("refresh of another sign-in: %d %s", w.Code, w.Body.String())
	}
}

func TestASignedOutSignInIsRefusedOnTheOtherRoutesAtOnce(t *testing.T) {
	signedIn := time.Now().Add(-time.Hour).Truncate(time.Second)
	api := cookieAPI(t, sessionState(0, signedIn.Unix()))
	if w := api.call(api.signInAt(signedIn), http.MethodGet, "/me", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("the signed-out sign-in: %d %s", w.Code, w.Body.String())
	}
	if w := api.call(api.signInAt(signedIn.Add(time.Second)), http.MethodGet, "/me", ""); w.Code != http.StatusOK {
		t.Fatalf("another sign-in: %d %s", w.Code, w.Body.String())
	}
	// A key's token of the same second is no sign-in.
	now := time.Now()
	api2 := newAuthAPI(t, pendingRequest{owner: "requester"}, sessionState(0, now.Unix(), now.Unix()+1))
	if w := api2.call(api2.keyToken(), http.MethodGet, "/me", ""); w.Code != http.StatusOK {
		t.Fatalf("a key's token: %d %s", w.Code, w.Body.String())
	}
}

// The other services cache this answer per user, so it lists every signed-out sign-in of the user.
func TestTheTokenVersionAnswerListsTheSignedOutSignIns(t *testing.T) {
	signedIn := time.Now().Add(-time.Hour).Truncate(time.Second)
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, sessionState(0, signedIn.Unix(), signedIn.Unix()+5))
	w := api.call(api.signInAt(signedIn.Add(time.Minute)), http.MethodGet, "/internal/token-version/owner", "")
	var got struct {
		TV        int     `json:"tv"`
		SignedOut []int64 `json:"signed_out"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &got) != nil {
		t.Fatalf("token-version: %d %s", w.Code, w.Body.String())
	}
	if got.TV != 0 || len(got.SignedOut) != 2 || got.SignedOut[0] != signedIn.Unix() || got.SignedOut[1] != signedIn.Unix()+5 {
		t.Fatalf("answer = %+v", got)
	}
	none := newAuthAPI(t, pendingRequest{owner: "requester"})
	if w := none.call(none.signInAt(signedIn), http.MethodGet, "/internal/token-version/owner", ""); !strings.Contains(w.Body.String(), `"signed_out":[]`) {
		t.Fatalf("no sign-out: %d %s", w.Code, w.Body.String())
	}
}
