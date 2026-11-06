package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// Re-QA #61 (decision B), the auth-service part: an admin endpoint refused by
// the app permission leaves an admin.access.denied failure row naming the
// permission, method and path. Every case returns before the database.

func memberRequest(method, path string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	return r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{
		UserID: "m1", Email: "m1@example.com",
		Perms: auth.PermissionMatrix{"*": {"menu.dashboard"}, "self": {"resource.*.read"}},
	}))
}

func TestAdminEndpoints_RefusalIsAudited(t *testing.T) {
	store := &memAuditStore{}
	cfg := config.Config{}
	cfg.AccessReview.Enabled = true
	ah := &AuthHandler{auditStore: store, cfg: cfg}
	rh := &RoleHandler{auditStore: store}
	ch := &ClustersHandler{auditStore: store}

	cases := []struct {
		name, method, path, perm string
		call                     http.HandlerFunc
	}{
		{"list users", http.MethodGet, "/api/v1/auth/admin/users", "admin.users.read", ah.AdminListUsers},
		{"delete user", http.MethodDelete, "/api/v1/auth/admin/users/u2", "admin.users.delete", ah.AdminDeleteUser},
		{"read audit log", http.MethodGet, "/api/v1/auth/admin/audit-logs", "admin.audit.read", ah.AdminListAuditLogs},
		{"create role", http.MethodPost, "/api/v1/auth/admin/roles", "admin.roles.create", rh.CreateRole},
		{"list access requests", http.MethodGet, "/api/v1/auth/admin/access-requests", "admin.users.update", ah.AdminListAccessRequests},
		{"access review", http.MethodGet, "/api/v1/auth/admin/access-review", "admin.review.read", ah.AdminAccessReview},
		{"past reviews", http.MethodGet, "/api/v1/auth/admin/access-review/history", "admin.review.read", ah.AdminAccessReviewHistory},
		{"a stored review", http.MethodGet, "/api/v1/auth/admin/access-review/history/r1", "admin.review.read", ah.AdminAccessReviewSnapshot},
		{"ai usage", http.MethodGet, "/api/v1/auth/admin/ai-usage", "admin.audit.read", ah.AdminAIUsage},
		{"audit integrity", http.MethodGet, "/api/v1/auth/admin/audit/integrity", "admin.audit.read", ah.AuditIntegrityStatus},
		{"register cluster", http.MethodPost, "/api/v1/clusters", auth.PermClustersCreate, ch.RegisterCluster},
		{"list every cluster", http.MethodGet, "/api/v1/clusters", auth.PermClustersList, ch.ListClusters},
	}
	for _, c := range cases {
		store.written = nil
		w := httptest.NewRecorder()
		c.call(w, memberRequest(c.method, c.path))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s: status %d, want 403", c.name, w.Code)
			continue
		}
		if len(store.written) != 1 {
			t.Errorf("%s: %d rows, want one", c.name, len(store.written))
			continue
		}
		rec := store.written[0]
		var after map[string]string
		_ = json.Unmarshal(rec.After, &after)
		if rec.Action != "admin.access.denied" || rec.Result != audit.ResultFailure || rec.ActorEmail != "m1@example.com" ||
			rec.TargetID != c.perm || after["permission"] != c.perm || after["method"] != c.method || after["path"] != c.path {
			t.Errorf("%s: row %s %s actor=%s target=%s after=%v", c.name, rec.Action, rec.Result, rec.ActorEmail, rec.TargetID, after)
		}
	}
}

// The AI's table (services/tool-server/screen_permissions.go, written out in this file) says what a screen asks. This
// holds its Admin reads to the routes behind those screens: each refuses with the permission the table names.
const toolScreenCasesFile = "../../../ai-service/tests/fixtures/tool_screen_permission_cases.json"

func TestAdminReadTools_AskWhatTheirRoutesAsk(t *testing.T) {
	raw, err := os.ReadFile(toolScreenCasesFile)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Tool string   `json:"tool"`
			Want []string `json:"want"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	wantFor := func(tool string) string {
		for _, c := range fixture.Cases {
			if c.Tool == tool && len(c.Want) == 1 {
				return c.Want[0]
			}
		}
		t.Fatalf("no case of %s", tool)
		return ""
	}
	store := &memAuditStore{}
	cfg := config.Config{}
	cfg.AccessReview.Enabled = true
	h := &AuthHandler{auditStore: store, cfg: cfg}
	for _, c := range []struct {
		tool string
		path string
		call http.HandlerFunc
	}{
		{"access_review", "/api/v1/auth/admin/access-review", h.AdminAccessReview},
		{"access_review", "/api/v1/auth/admin/access-review/history", h.AdminAccessReviewHistory},
		{"access_review", "/api/v1/auth/admin/access-review/history/r1", h.AdminAccessReviewSnapshot},
		{"ai_usage", "/api/v1/auth/admin/ai-usage", h.AdminAIUsage},
		{"access_requests", "/api/v1/auth/admin/access-requests", h.AdminListAccessRequests},
		{"audit_integrity", "/api/v1/auth/admin/audit/integrity", h.AuditIntegrityStatus},
	} {
		store.written = nil
		w := httptest.NewRecorder()
		c.call(w, memberRequest(http.MethodGet, c.path))
		want := wantFor(c.tool)
		if w.Code != http.StatusForbidden || len(store.written) != 1 || store.written[0].TargetID != want {
			t.Errorf("%s %s: status %d rows %+v, want 403 naming %s", c.tool, c.path, w.Code, store.written, want)
		}
	}
}

func TestRequirePerm_RecordsOnlyARefusedSignedInCaller(t *testing.T) {
	store := &memAuditStore{}

	// no token in the context: 403, nobody to name, no row
	w := httptest.NewRecorder()
	if _, ok := requirePerm(store, w, httptest.NewRequest(http.MethodGet, "/x", nil), "admin.users.read"); ok || w.Code != http.StatusForbidden {
		t.Fatalf("anonymous: ok=%v status=%d", ok, w.Code)
	}
	// the permission held: allowed, no row
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "a", Perms: auth.PermissionMatrix{"*": {"admin.users.*"}}}))
	if p, ok := requirePerm(store, httptest.NewRecorder(), r, "admin.users.read"); !ok || p.UserID != "a" {
		t.Fatalf("allowed: ok=%v payload=%+v", ok, p)
	}
	if len(store.written) != 0 {
		t.Fatalf("rows %+v, want none", store.written)
	}
	// a nil store (audit off in a test) still refuses
	w = httptest.NewRecorder()
	if _, ok := requirePerm(nil, w, memberRequest(http.MethodGet, "/x"), "admin.users.read"); ok || w.Code != http.StatusForbidden {
		t.Fatalf("nil store: ok=%v status=%d", ok, w.Code)
	}
}
