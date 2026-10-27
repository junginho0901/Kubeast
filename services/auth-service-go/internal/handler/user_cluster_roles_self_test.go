package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A grant change on one's own account would end one's own sessions (the token carries the old matrix), so it is
// refused like a change of one's own role, with a failure row — before the database.
func TestClusterRole_OwnAccessIsRefused(t *testing.T) {
	store := &memAuditStore{}
	ah := &AuthHandler{auditStore: store}
	req := func(method, body string) *http.Request {
		r := httptest.NewRequest(method, "/api/v1/auth/admin/users/a1/cluster-roles/default", strings.NewReader(body))
		rc := chi.NewRouteContext()
		rc.URLParams.Add("user_id", "a1")
		rc.URLParams.Add("cluster_id", "default")
		ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rc)
		return r.WithContext(auth.WithPayload(ctx, auth.TokenPayload{UserID: "a1", Email: "a1@example.com", Perms: auth.PermissionMatrix{"*": {"admin.users.update", "resource.*.read"}}}))
	}
	for _, c := range []struct {
		name, method, body, action string
		call                       http.HandlerFunc
	}{
		{"set", http.MethodPut, `{"role":"Read"}`, "user.cluster_role.set", ah.SetUserClusterRole},
		{"unset", http.MethodDelete, ``, "user.cluster_role.unset", ah.DeleteUserClusterRole},
	} {
		store.written = nil
		w := httptest.NewRecorder()
		c.call(w, req(c.method, c.body))
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "own cluster access") {
			t.Errorf("%s: %d %s, want 403 own cluster access", c.name, w.Code, w.Body.String())
			continue
		}
		if len(store.written) != 1 || store.written[0].Action != c.action || store.written[0].Result != audit.ResultFailure {
			t.Errorf("%s: audit rows %+v, want one %s failure", c.name, store.written, c.action)
		}
	}
}
