package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The refusals that happen before any database access: unknown permission
// strings, a role wider than its creator, and changing one's own role. The
// database-backed paths are covered by the e2e permission-ceiling spec.

func limitedAdminRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	return r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{
		UserID: "la", Email: "la@example.com",
		Perms: auth.PermissionMatrix{"*": {"admin.users.*", "admin.roles.*", "menu.*"}},
	}))
}

func TestCreateRole_RefusesUnknownAndWiderPermissions(t *testing.T) {
	store := &memAuditStore{}
	h := &RoleHandler{auditStore: store} // repo stays nil: every case returns before it

	w := httptest.NewRecorder()
	h.CreateRole(w, limitedAdminRequest(http.MethodPost, "/auth/admin/roles", `{"name":"x","permissions":["menu.dashboard","made.up"]}`))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "made.up") {
		t.Fatalf("unknown permission: %d %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	h.CreateRole(w, limitedAdminRequest(http.MethodPost, "/auth/admin/roles", `{"name":"x","permissions":["menu.dashboard","admin.audit.read","*"]}`))
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "admin.audit.read") {
		t.Fatalf("wider than the creator: %d %s", w.Code, w.Body.String())
	}
	if len(store.written) != 1 || store.written[0].Action != "admin.roles.create" || store.written[0].Result != audit.ResultFailure ||
		!strings.Contains(store.written[0].Error, "permission ceiling") {
		t.Fatalf("the refusal must be audited as a failure: %+v", store.written)
	}
}

func TestAdminUpdateUser_RefusesOwnRoleChange(t *testing.T) {
	h := &AuthHandler{} // repo stays nil: the check runs before the lookup
	r := chi.NewRouter()
	r.Patch("/auth/admin/users/{user_id}", h.AdminUpdateUser)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, limitedAdminRequest(http.MethodPatch, "/auth/admin/users/la", `{"role_id":1}`))
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "own role") {
		t.Fatalf("own role change: %d %s", w.Code, w.Body.String())
	}
}
