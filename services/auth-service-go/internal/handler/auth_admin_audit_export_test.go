package handler

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// memAuditStore is an in-memory audit.Store: Write appends, List pages.
type memAuditStore struct {
	entries []audit.Entry
	written []audit.Record
	lists   int
}

func (m *memAuditStore) Write(_ context.Context, rec audit.Record) (int64, error) {
	m.written = append(m.written, rec)
	return int64(len(m.written)), nil
}

func (m *memAuditStore) List(_ context.Context, f audit.Filter) ([]audit.Entry, int, error) {
	m.lists++
	if f.Offset >= len(m.entries) {
		return nil, len(m.entries), nil
	}
	end := f.Offset + f.Limit
	if end > len(m.entries) {
		end = len(m.entries)
	}
	return m.entries[f.Offset:end], len(m.entries), nil
}

func (m *memAuditStore) Get(context.Context, int64) (*audit.Entry, error) { return nil, nil }

func exportRequest(perms auth.PermissionMatrix, query string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/auth/admin/audit-logs/export"+query, nil)
	return r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: perms}))
}

func TestAdminExportAuditLogs_Forbidden(t *testing.T) {
	h := &AuthHandler{auditStore: &memAuditStore{}}
	w := httptest.NewRecorder()
	h.AdminExportAuditLogs(w, exportRequest(auth.PermissionMatrix{"*": {"admin.audit.read"}}, ""))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestAdminExportAuditLogs_CSV(t *testing.T) {
	store := &memAuditStore{}
	base := time.Date(2026, 9, 29, 1, 2, 3, 0, time.UTC)
	for i := 0; i < 1500; i++ {
		store.entries = append(store.entries, audit.Entry{
			ID:        int64(i + 1),
			CreatedAt: base.Add(time.Duration(i) * time.Second),
			Record: audit.Record{
				Service: audit.ServiceK8s, Action: "k8s.pod.delete", Result: audit.ResultSuccess,
				ActorEmail: "user@example.com", Cluster: "self", Namespace: "default",
				TargetType: "pod", TargetID: fmt.Sprintf("pod-%d", i),
				After: json.RawMessage(`{"note":"has, comma and \"quotes\""}`),
			},
		})
	}
	h := &AuthHandler{auditStore: store}
	w := httptest.NewRecorder()
	h.AdminExportAuditLogs(w, exportRequest(auth.PermissionMatrix{"*": {"admin.audit.export"}}, "?cluster=self&action=k8s.pod.delete"))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/csv; charset=utf-8" {
		t.Errorf("content-type = %q", ct)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, `attachment; filename="audit-logs-`) || !strings.HasSuffix(cd, `.csv"`) {
		t.Errorf("content-disposition = %q", cd)
	}
	body := w.Body.String()
	if !strings.HasPrefix(body, "\xEF\xBB\xBF") {
		t.Error("body does not start with a UTF-8 BOM")
	}
	if !strings.Contains(body, "\r\n") {
		t.Error("records are not CRLF-terminated")
	}
	rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(body, "\xEF\xBB\xBF"))).ReadAll()
	if err != nil {
		t.Fatalf("csv parse: %v", err)
	}
	if len(rows) != 1501 {
		t.Fatalf("rows = %d, want header + 1500", len(rows))
	}
	if strings.Join(rows[0], ",") != strings.Join(exportColumns, ",") {
		t.Errorf("header = %v", rows[0])
	}
	if rows[1][0] != "1" || rows[1][1] != "2026-09-29T01:02:03Z" || rows[1][3] != "k8s.pod.delete" || rows[1][11] != "pod-0" {
		t.Errorf("first row = %v", rows[1])
	}
	if rows[1][17] != `{"note":"has, comma and \"quotes\""}` {
		t.Errorf("after column not round-tripped: %q", rows[1][17])
	}
	if store.lists != 2 {
		t.Errorf("List calls = %d, want 2 (1000 + 500)", store.lists)
	}
	if len(store.written) != 1 || store.written[0].Action != "admin.audit.export" || store.written[0].ActorEmail != "admin@example.com" {
		t.Fatalf("export audit record = %+v", store.written)
	}
	var after map[string]interface{}
	_ = json.Unmarshal(store.written[0].After, &after)
	if after["rows"] != float64(1500) || after["truncated"] != false {
		t.Errorf("export audit after = %v", after)
	}
	if f, _ := after["filter"].(map[string]interface{}); f["Cluster"] != "self" || f["Action"] != "k8s.pod.delete" {
		t.Errorf("export audit filter = %v", f)
	}
}
