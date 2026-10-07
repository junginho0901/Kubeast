package handler

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/accessreview"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func reviewHandler(enabled bool) *AuthHandler {
	return &AuthHandler{auditStore: &memAuditStore{}, cfg: config.Config{AccessReview: config.AccessReviewConfig{Enabled: enabled, DormantDays: 90, IntervalDays: 90}}}
}

func reviewRequest(method, path string, perms auth.PermissionMatrix) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	return r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: perms}))
}

func TestAccessReviewConfig(t *testing.T) {
	w := httptest.NewRecorder()
	reviewHandler(true).AccessReviewConfig(w, httptest.NewRequest(http.MethodGet, "/auth/access-review/config", nil))
	var got accessReviewConfigResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Enabled || got.DormantDays != 90 || got.IntervalDays != 90 {
		t.Fatalf("config = %+v", got)
	}
}

func TestAccessReview_DisabledIs404(t *testing.T) {
	h := reviewHandler(false)
	admin := auth.PermissionMatrix{"*": {"*"}}
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){
		"report":   h.AdminAccessReview,
		"export":   h.AdminAccessReviewExport,
		"signoff":  h.AdminAccessReviewSignoff,
		"history":  h.AdminAccessReviewHistory,
		"snapshot": h.AdminAccessReviewSnapshot,
	} {
		w := httptest.NewRecorder()
		call(w, reviewRequest(http.MethodGet, "/auth/admin/access-review?section=users", admin))
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", name, w.Code)
		}
	}
}

func TestAccessReview_PermissionPerHandler(t *testing.T) {
	h := reviewHandler(true)
	cases := []struct {
		name string
		call func(http.ResponseWriter, *http.Request)
		has  string
	}{
		{"report needs read", h.AdminAccessReview, "admin.review.export"},
		{"export needs export", h.AdminAccessReviewExport, "admin.review.read"},
		{"signoff needs signoff", h.AdminAccessReviewSignoff, "admin.review.read"},
		{"history needs read", h.AdminAccessReviewHistory, "admin.review.signoff"},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		c.call(w, reviewRequest(http.MethodGet, "/auth/admin/access-review?section=users", auth.PermissionMatrix{"*": {c.has}}))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s: status = %d, want 403", c.name, w.Code)
		}
	}
	// A bad section is rejected before any database read.
	w := httptest.NewRecorder()
	h.AdminAccessReviewExport(w, reviewRequest(http.MethodGet, "/auth/admin/access-review/export?section=nope", auth.PermissionMatrix{"*": {"admin.review.export"}}))
	if w.Code != http.StatusBadRequest {
		t.Errorf("bad section: status = %d, want 400", w.Code)
	}
	w = httptest.NewRecorder()
	h.AdminAccessReview(w, reviewRequest(http.MethodGet, "/auth/admin/access-review?since=yesterday", auth.PermissionMatrix{"*": {"admin.review.read"}}))
	if w.Code != http.StatusBadRequest {
		t.Errorf("bad since: status = %d, want 400", w.Code)
	}
}

func TestAccessReviewCSV(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	last := now.Add(-time.Hour)
	rep := &accessreview.Report{
		GeneratedAt: now,
		Users: []accessreview.UserRow{{Email: "a@example.com", Name: "A", Team: "sre", AuthSource: "password", GlobalRole: "Admin", CreatedAt: now, LastLoginAt: &last,
			ClusterRoles: 2, APIKeys: 1, TemporaryGrants: 0, Flags: []string{"global_admin"}}},
		AccessRequests: []accessreview.AccessRequestRow{{RequesterEmail: "b@example.com", Cluster: "prod", Role: "Write", DurationMinutes: 60,
			Reason: "=HYPERLINK(\"x\")", Status: "approved", CreatedAt: now}},
		Roles: []accessreview.RoleRow{{Name: "Admin", IsSystem: true, Permissions: []string{"*"}, Users: 1, Flags: []string{"has_admin_permissions"}}},
	}
	for _, section := range accessReviewSections {
		header, rows := accessReviewCSV(rep, section)
		if header == nil {
			t.Errorf("%s: no header", section)
			continue
		}
		for _, row := range rows {
			if len(row) != len(header) {
				t.Errorf("%s: row has %d cells, header %d", section, len(row), len(header))
			}
		}
	}
	header, rows := accessReviewCSV(rep, "users")
	if header[0] != "email" || rows[0][6] != "2026-10-07T11:00:00Z" || rows[0][11] != "global_admin" {
		t.Errorf("users row = %v", rows[0])
	}
	_, rows = accessReviewCSV(rep, "access_requests")
	if !strings.HasPrefix(rows[0][4], "'=") {
		t.Errorf("formula-looking reason must be neutralised, got %q", rows[0][4])
	}
	if h, _ := accessReviewCSV(rep, "nope"); h != nil {
		t.Errorf("unknown section should render nothing")
	}

	var buf bytes.Buffer
	header, rows = accessReviewCSV(rep, "roles")
	writeCSV(&buf, header, rows)
	if !bytes.HasPrefix(buf.Bytes(), []byte{0xEF, 0xBB, 0xBF}) || !strings.Contains(buf.String(), "\r\n") {
		t.Errorf("CSV must start with a BOM and use CRLF")
	}
	records, err := csv.NewReader(bytes.NewReader(buf.Bytes()[3:])).ReadAll()
	if err != nil || len(records) != 2 || records[1][0] != "Admin" || records[1][3] != "*" {
		t.Errorf("roles csv = %v err = %v", records, err)
	}
}
