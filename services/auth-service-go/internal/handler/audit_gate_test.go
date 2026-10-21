package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// readyStore is memAuditStore with a fail-closed check that can be turned off.
type readyStore struct {
	memAuditStore
	down bool
}

func (s *readyStore) Ready(context.Context) error {
	if s.down {
		return audit.ErrUnavailable
	}
	return nil
}

// While the audit store cannot take a row, admin and account writes are
// refused (decision 2026-10-20 B1 = 가); refreshing a token, changing one's own
// password, the cluster-switch beacon and every read go through.
func TestAdminWritesGateRefusesOnlyAdminWrites(t *testing.T) {
	store := &readyStore{down: true}
	ran := false
	h := AdminWritesGate(store)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		ran = true
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, c := range []struct {
		method, path string
		refused      bool
	}{
		{http.MethodPost, "/api/v1/auth/admin/users", true},
		{http.MethodPatch, "/api/v1/auth/admin/users/u1", true},
		{http.MethodPut, "/api/v1/auth/admin/users/u1/cluster-roles/self", true},
		{http.MethodPost, "/api/v1/auth/admin/roles", true},
		{http.MethodPost, "/api/v1/auth/api-keys", true},
		{http.MethodPost, "/api/v1/auth/admin/access-requests/a1/approve", true},
		{http.MethodPost, "/api/v1/auth/setup", true},
		{http.MethodPost, "/api/v1/clusters", true},
		{http.MethodDelete, "/api/v1/clusters/c1", true},
		{http.MethodPost, "/api/v1/auth/refresh", false},
		{http.MethodPost, "/api/v1/auth/change-password", false},
		{http.MethodPost, "/api/v1/audit/cluster-switch", false},
		{http.MethodGet, "/api/v1/auth/admin/users", false},
	} {
		ran = false
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(c.method, c.path, nil))
		if c.refused != (w.Code == http.StatusServiceUnavailable) || c.refused == ran {
			t.Errorf("%s %s: status %d ran %v, refused want %v", c.method, c.path, w.Code, ran, c.refused)
		}
	}
	store.down = false
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/auth/admin/users", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("store back: the write runs again, got %d", w.Code)
	}
}

// The audit log is not read (List not called) when its read cannot be recorded.
func TestAuditLogReadIsRefusedBeforeTheData(t *testing.T) {
	store := &readyStore{down: true}
	h := &AuthHandler{auditStore: store}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/admin/audit-logs", nil)
	r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": {"admin.audit.read"}}}))
	w := httptest.NewRecorder()
	h.AdminListAuditLogs(w, r)
	if w.Code != http.StatusServiceUnavailable || store.lists != 0 {
		t.Fatalf("status %d, List calls %d", w.Code, store.lists)
	}
	store.down = false
	w = httptest.NewRecorder()
	h.AdminListAuditLogs(w, r)
	if w.Code != http.StatusOK || store.lists != 1 {
		t.Fatalf("store back: status %d, List calls %d", w.Code, store.lists)
	}
}

// Every sensitive read answers 503 before touching its data (no List, no
// repository — the handler has none here) while its row cannot be stored.
func TestSensitiveReadsAreRefusedWhileTheAuditStoreIsDown(t *testing.T) {
	store := &readyStore{down: true}
	h := &AuthHandler{auditStore: store}
	h.cfg.AccessReview.Enabled = true
	perms := auth.PermissionMatrix{"*": {"admin.audit.read", "admin.audit.export", "admin.review.read", "admin.review.export", "admin.users.read"}}
	for name, call := range map[string]http.HandlerFunc{
		"audit log":       h.AdminListAuditLogs,
		"audit export":    h.AdminExportAuditLogs,
		"AI usage":        h.AdminAIUsage,
		"access review":   h.AdminAccessReview,
		"review export":   h.AdminAccessReviewExport,
		"review snapshot": h.AdminAccessReviewSnapshot,
		"oidc groups":     h.AdminOIDCGroups,
	} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/admin/x?section=users", nil)
		r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: perms}))
		w := httptest.NewRecorder()
		call(w, r)
		if w.Code != http.StatusServiceUnavailable || store.lists != 0 {
			t.Errorf("%s: status %d, List calls %d", name, w.Code, store.lists)
		}
	}
}
