package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

const (
	testPassword = "Correct-horse-battery-9"
	readPerm     = "resource.pod.read"
	pgTimestamp  = "2006-01-02 15:04:05+00"
)

type recordedAudit struct {
	audit.Store
	mu   sync.Mutex
	rows []audit.Record
}

func (s *recordedAudit) Write(_ context.Context, rec audit.Record) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows = append(s.rows, rec)
	return int64(len(s.rows)), nil
}

func (s *recordedAudit) failures(action string) []audit.Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []audit.Record
	for _, rec := range s.rows {
		if rec.Action == action && rec.Result == audit.ResultFailure {
			out = append(out, rec)
		}
	}
	return out
}

func (s *recordedAudit) successes(action string) []audit.Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []audit.Record
	for _, rec := range s.rows {
		if rec.Action == action && rec.Result != audit.ResultFailure { // empty means success
			out = append(out, rec)
		}
	}
	return out
}

type authAPI struct {
	t      *testing.T
	db     *fakePG
	store  *recordedAudit
	mgr    *security.JWTManager
	router http.Handler
}

// pendingRequest is the access request the fake database holds; a nil
// namespaces asks for the whole cluster.
type pendingRequest struct {
	owner      string
	namespaces any
}

// newAuthAPI wires the protected routes as main does, over a fake database
// holding one user, one role and one pending access request. Rules in extra are
// asked first, so a test can name its own accounts and roles.
func newAuthAPI(t *testing.T, pending pendingRequest, extra ...pgRule) *authAPI {
	t.Helper()
	return newAuthAPIWith(t, pending, nil, extra...)
}

// newAuthAPIWith is newAuthAPI with a test's own settings on top of the defaults.
func newAuthAPIWith(t *testing.T, pending pendingRequest, settings func(*config.Config), extra ...pgRule) *authAPI {
	t.Helper()
	hash, err := security.HashPassword(testPassword, 1000)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(pgTimestamp)
	later := time.Now().Add(time.Hour).UTC().Format(pgTimestamp)
	text, integer, stamp := uint32(pgtype.TextOID), uint32(pgtype.Int4OID), uint32(pgtype.TimestamptzOID)
	list, boolean := uint32(pgtype.TextArrayOID), uint32(pgtype.BoolOID)
	db, pool := startFakePG(t, append(extra,
		pgRule{match: "SELECT token_version FROM auth_users", oids: []uint32{integer}, rows: [][]any{{0}}},
		pgRule{match: "SELECT expires_at FROM api_keys", oids: []uint32{stamp}, rows: [][]any{{later}}},
		pgRule{match: "FROM auth_users u JOIN roles r ON r.id = u.role_id",
			oids: []uint32{text, text, text, text, integer, text, text, integer, text, stamp, stamp, stamp, stamp, stamp},
			rows: [][]any{{"owner", "Owner", "owner@example.com", nil, 1, "Member", hash, 0, "password", now, now, nil, nil, nil}}},
		pgRule{match: "FROM roles WHERE name",
			oids: []uint32{integer, text, text, boolean, stamp, stamp},
			rows: [][]any{{2, "Write", "", "t", now, now}}},
		pgRule{match: "FROM role_permissions", oids: []uint32{text}, rows: [][]any{{readPerm}}},
		pgRule{match: "AND ucr.cluster_id =", oids: []uint32{text, integer, text, stamp, list},
			rows: [][]any{{"c", 3, "Read", nil, nil}}},
		pgRule{match: "SELECT COUNT(*) FROM access_requests", oids: []uint32{integer}, rows: [][]any{{0}}},
		pgRule{match: "DELETE FROM api_keys",
			oids: []uint32{text, text, text, text, list, text, stamp, stamp, text, stamp},
			rows: [][]any{{"other-key", "owner", "other", "kbk_other", nil, "Read", later, nil, nil, now}}},
		pgRule{match: "WHERE ar.id =",
			oids: []uint32{text, text, text, text, text, text, integer, text, integer, text, text, stamp, text, text, stamp, text, stamp, stamp, text, list},
			rows: [][]any{{"r1", pending.owner, "req@example.com", "Req", "c", "c", 2, "Write", 30, "needed", "pending", now, nil, nil, nil, nil, nil, nil, nil, pending.namespaces}}},
		pgRule{match: "duration_minutes, namespaces FROM access_requests",
			oids: []uint32{text, text, integer, integer, list},
			rows: [][]any{{pending.owner, "c", 2, 30, pending.namespaces}}},
	)...)
	repo := repository.New(pool)
	mgr, err := security.NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		APIKeys:                config.APIKeysConfig{Enabled: true, MaxDays: 90},
		AccessRequests:         config.AccessRequestsConfig{Enabled: true, MaxHours: 8, Roles: []string{"Write"}},
		PasswordHashIterations: 1000,
		PasswordMinLength:      12,
		JWTExpiresMinutes:      5,
	}
	if settings != nil {
		settings(&cfg)
	}
	store := &recordedAudit{}
	authHandler := handler.NewAuthHandler(repo, mgr, cfg, store)
	roleHandler := handler.NewRoleHandler(repo, store, cfg.ImpersonationCustomRoles)
	setupHandler := handler.NewSetupHandler(cfg, nil, nil, store)
	authMiddleware := security.AuthMiddleware(mgr, repo.TokenVersionFor, "kubeast.token")
	clusterListAuth := security.InvestigatorReadMiddleware(mgr, repo.TokenVersionFor, "kubeast.token", cfg.AlertInvestigationEnabled)
	r := chi.NewRouter()
	r.Route("/api/v1/auth", func(r chi.Router) {
		publicAuthRoutes(r, authHandler, setupHandler, cfg.InternalAPIToken)
		r.Group(func(r chi.Router) {
			r.Use(authMiddleware)
			r.Use(handler.AdminWritesGate(store))
			protectedAuthRoutes(r, authHandler, roleHandler, setupHandler, store)
		})
	})
	topLevelRoutes(r, authMiddleware, clusterListAuth, authHandler, handler.NewClustersHandler(cluster.NewPostgresRegistry(pool, nil), nil, store, cfg), setupHandler, store)
	return &authAPI{t: t, db: db, store: store, mgr: mgr, router: r}
}

func (a *authAPI) call(token, method, path, body string) *httptest.ResponseRecorder {
	a.t.Helper()
	req := httptest.NewRequest(method, "/api/v1/auth"+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.router.ServeHTTP(w, req)
	return w
}

// keyToken is what a Read key limited to one cluster is exchanged for.
func (a *authAPI) keyToken() string {
	a.t.Helper()
	tok, err := a.mgr.CreateAPIKeyToken("owner", "owner@example.com", "Member", auth.PermissionMatrix{"c": {readPerm}}, map[string]string{"c": "Read"}, nil, 0, "key-1")
	if err != nil {
		a.t.Fatal(err)
	}
	return tok
}

func (a *authAPI) sessionToken() string {
	a.t.Helper()
	tok, err := a.mgr.CreateToken("owner", "owner@example.com", "Member", auth.PermissionMatrix{"c": {readPerm}}, map[string]string{"c": "Read"}, nil, 0)
	if err != nil {
		a.t.Fatal(err)
	}
	return tok
}

// The account stays with the person: these answer a signed-in session and
// refuse a token an API key was exchanged for, before anything is written.
var sessionOnlyRoutes = []struct {
	name, method, path, body, action, write string
	sessionStatus                           int
}{
	{"create a key", http.MethodPost, "/api-keys", `{"name":"k","expires_in_days":1}`, "user.apikey.create", "INSERT INTO api_keys", http.StatusCreated},
	{"delete a key", http.MethodDelete, "/api-keys/other-key", "", "user.apikey.delete", "DELETE FROM api_keys", http.StatusNoContent},
	{"change the password", http.MethodPost, "/change-password", `{"current_password":"` + testPassword + `","new_password":"Another-long-phrase-77"}`, "user.password.change", "SET password_hash", http.StatusOK},
}

func TestAPIKeyTokenCannotChangeTheAccount(t *testing.T) {
	for _, c := range sessionOnlyRoutes {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"})
			w := api.call(api.keyToken(), c.method, c.path, c.body)
			if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "API key") {
				t.Errorf("key token: %d %s, want 403 naming the API key", w.Code, w.Body.String())
			}
			if api.db.ran(c.write) {
				t.Errorf("key token: %q reached the database", c.write)
			}
			if rows := api.store.failures(c.action); len(rows) != 1 || !strings.Contains(string(rows[0].After), "key-1") {
				t.Errorf("key token: audit failures of %s = %+v, want one naming the key", c.action, rows)
			}

			api.db.forget()
			if w := api.call(api.sessionToken(), c.method, c.path, c.body); w.Code != c.sessionStatus {
				t.Errorf("session: %d %s, want %d", w.Code, w.Body.String(), c.sessionStatus)
			}
			if !api.db.ran(c.write) {
				t.Errorf("session: %q never reached the database", c.write)
			}
		})
	}
}

func TestAPIKeyTokenCannotCancelAnAccessRequest(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "owner"})
	w := api.call(api.keyToken(), http.MethodDelete, "/access-requests/r1", "")
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "API key") {
		t.Errorf("key token: %d %s, want 403 naming the API key", w.Code, w.Body.String())
	}
	if api.db.ran("UPDATE access_requests") {
		t.Error("key token: the request was cancelled")
	}
	if rows := api.store.failures("access.request.cancel"); len(rows) != 1 {
		t.Errorf("key token: audit failures = %+v, want one", rows)
	}
	if w := api.call(api.sessionToken(), http.MethodDelete, "/access-requests/r1", ""); w.Code != http.StatusNoContent {
		t.Errorf("session: %d %s, want 204", w.Code, w.Body.String())
	}
}

// What a key is for keeps working: reading its own account and, for the MCP
// tool request_access, filing an access request an admin then decides.
func TestAPIKeyTokenKeepsItsOtherRoutes(t *testing.T) {
	for _, c := range []struct {
		method, path, body string
		want               int
	}{
		{http.MethodGet, "/me", "", http.StatusOK},
		{http.MethodGet, "/permissions", "", http.StatusOK},
		{http.MethodGet, "/api-keys/config", "", http.StatusOK},
		{http.MethodGet, "/api-keys", "", http.StatusOK},
		{http.MethodGet, "/access-requests/config", "", http.StatusOK},
		{http.MethodGet, "/access-requests", "", http.StatusOK},
		{http.MethodGet, "/access-review/config", "", http.StatusOK},
		{http.MethodGet, "/dormant-accounts/config", "", http.StatusOK},
		{http.MethodPost, "/access-requests", `{"cluster_id":"c","role":"Write","duration_minutes":30,"reason":"needed"}`, http.StatusCreated},
	} {
		t.Run(c.method+" "+c.path, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"})
			if w := api.call(api.keyToken(), c.method, c.path, c.body); w.Code != c.want {
				t.Errorf("%d %s, want %d", w.Code, w.Body.String(), c.want)
			}
		})
	}
}

// What a key's token reads of its own account is what that key can do, not what its owner can.
func TestMeAnswersAKeyTokenWithTheKeysOwnReach(t *testing.T) {
	const wide = "resource.pod.delete"
	rules := []pgRule{
		{match: "FROM role_permissions", oids: []uint32{uint32(pgtype.TextOID)}, rows: [][]any{{"admin.users.read"}, {readPerm}, {wide}}},
		{match: "SELECT cluster_id, role_id, namespaces FROM user_cluster_roles", oids: []uint32{uint32(pgtype.TextOID), uint32(pgtype.Int4OID), uint32(pgtype.TextArrayOID)},
			rows: [][]any{{"c", 3, nil}, {"prod", 3, nil}}},
		{match: "SELECT ucr.cluster_id, ro.name", oids: []uint32{uint32(pgtype.TextOID), uint32(pgtype.TextOID)}, rows: [][]any{{"c", "Admin"}, {"prod", "Admin"}}},
		{match: "SELECT cluster_id, namespaces FROM user_cluster_roles", oids: []uint32{uint32(pgtype.TextOID), uint32(pgtype.TextArrayOID)}, rows: [][]any{{"prod", "{shop}"}}},
	}
	type me struct {
		Email string `json:"email"`
		Role  struct {
			Permissions []string `json:"permissions"`
		} `json:"role"`
		Matrix     auth.PermissionMatrix `json:"permissions_matrix"`
		Roles      map[string]string     `json:"cluster_roles"`
		Namespaces map[string][]string   `json:"cluster_namespaces"`
	}
	read := func(api *authAPI, token string) me {
		t.Helper()
		w := api.call(token, http.MethodGet, "/me", "")
		if w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		var out me
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, rules...)
	key := read(api, api.keyToken())
	if !reflect.DeepEqual(key.Matrix, auth.PermissionMatrix{"c": {readPerm}}) {
		t.Errorf("a key's matrix = %v", key.Matrix)
	}
	if !reflect.DeepEqual(key.Roles, map[string]string{"c": "Read"}) {
		t.Errorf("a key's roles = %v", key.Roles)
	}
	if len(key.Namespaces) != 0 {
		t.Errorf("a key's namespaces = %v", key.Namespaces)
	}
	if !reflect.DeepEqual(key.Role.Permissions, []string{readPerm}) {
		t.Errorf("a key's role permissions = %v", key.Role.Permissions)
	}
	if key.Email != "owner@example.com" {
		t.Errorf("a key still names its owner: %q", key.Email)
	}
	// The session of the same account reads the whole of it, as before.
	session := read(api, api.sessionToken())
	if !reflect.DeepEqual(session.Roles, map[string]string{"c": "Admin", "prod": "Admin"}) || !reflect.DeepEqual(session.Namespaces, map[string][]string{"prod": {"shop"}}) {
		t.Errorf("a session's grants = %v %v", session.Roles, session.Namespaces)
	}
	if !auth.MatchAny(session.Matrix["prod"], wide) || !auth.MatchAny(session.Role.Permissions, wide) {
		t.Errorf("a session's permissions = %v %v", session.Matrix, session.Role.Permissions)
	}
}

// A key token holds no global entry, so the admin routes refuse it themselves;
// a refresh keeps its own answer.
func TestAPIKeyTokenStaysOutOfAdminRoutes(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"})
	tok := api.keyToken()
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/admin/users"},
		{http.MethodGet, "/admin/audit-logs"},
		{http.MethodPut, "/admin/users/target/cluster-roles/c"},
		{http.MethodDelete, "/admin/users/owner/api-keys/other-key"},
		{http.MethodPost, "/admin/access-requests/r1/approve"},
		{http.MethodPost, "/setup"},
	} {
		if w := api.call(tok, c.method, c.path, "{}"); w.Code != http.StatusForbidden {
			t.Errorf("%s %s: %d %s, want 403", c.method, c.path, w.Code, w.Body.String())
		}
	}
	if w := api.call(tok, http.MethodPost, "/refresh", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("refresh: %d %s, want 401", w.Code, w.Body.String())
	}
}

// grantor signs in with admin.users.update and a role on cluster c, limited to
// the given namespaces.
func (a *authAPI) grantor(global []string, namespaces ...string) string {
	a.t.Helper()
	var ns map[string][]string
	if len(namespaces) > 0 {
		ns = map[string][]string{"c": namespaces}
	}
	tok, err := a.mgr.CreateToken("grantor", "grantor@example.com", "Member", auth.PermissionMatrix{"*": global, "c": {readPerm}}, map[string]string{"c": "Read"}, ns, 0)
	if err != nil {
		a.t.Fatal(err)
	}
	return tok
}

func TestGrantStaysWithinTheGrantorsNamespaces(t *testing.T) {
	const grantPath = "/admin/users/target/cluster-roles/c"
	userAdmin := []string{"admin.users.update"}
	for _, c := range []struct {
		name, body  string
		global      []string
		grantorNS   []string
		want        int
		wantInError string
	}{
		{"the whole cluster from a limited grantor", `{"role":"Write"}`, userAdmin, []string{"team-a"}, http.StatusForbidden, "whole cluster"},
		{"a namespace outside a limited grantor's", `{"role":"Write","namespaces":["team-b"]}`, userAdmin, []string{"team-a"}, http.StatusForbidden, "team-b"},
		{"a namespace of a limited grantor's", `{"role":"Write","namespaces":["team-a"]}`, userAdmin, []string{"team-a"}, http.StatusOK, ""},
		{"the whole cluster from an unlimited grantor", `{"role":"Write"}`, userAdmin, nil, http.StatusOK, ""},
		{"the whole cluster from a global admin with a limited grant", `{"role":"Write"}`, []string{"*"}, []string{"team-a"}, http.StatusOK, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"})
			w := api.call(api.grantor(c.global, c.grantorNS...), http.MethodPut, grantPath, c.body)
			if w.Code != c.want || !strings.Contains(w.Body.String(), c.wantInError) {
				t.Fatalf("%d %s, want %d with %q", w.Code, w.Body.String(), c.want, c.wantInError)
			}
			if wrote := api.db.ran("INSERT INTO user_cluster_roles"); wrote != (c.want == http.StatusOK) {
				t.Errorf("grant written = %v with status %d", wrote, w.Code)
			}
			if c.want == http.StatusForbidden && len(api.store.failures("user.cluster_role.set")) != 1 {
				t.Errorf("the refusal must leave one failure row: %+v", api.store.rows)
			}
		})
	}
}

func TestApprovalStaysWithinTheApproversNamespaces(t *testing.T) {
	userAdmin := []string{"admin.users.update"}
	for _, c := range []struct {
		name       string
		requested  any
		approverNS []string
		want       int
	}{
		{"the whole cluster", nil, []string{"team-a"}, http.StatusForbidden},
		{"a namespace outside the approver's", "{team-b}", []string{"team-a"}, http.StatusForbidden},
		{"a namespace of the approver's", "{team-a}", []string{"team-a"}, http.StatusOK},
		{"the whole cluster from an unlimited approver", nil, nil, http.StatusOK},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester", namespaces: c.requested})
			w := api.call(api.grantor(userAdmin, c.approverNS...), http.MethodPost, "/admin/access-requests/r1/approve", "")
			if w.Code != c.want {
				t.Fatalf("%d %s, want %d", w.Code, w.Body.String(), c.want)
			}
			if wrote := api.db.ran("INSERT INTO user_cluster_roles"); wrote != (c.want == http.StatusOK) {
				t.Errorf("grant written = %v with status %d", wrote, w.Code)
			}
		})
	}
}
