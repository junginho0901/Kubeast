package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

type auditPage struct {
	Total       int     `json:"total"`
	AsOf        int64   `json:"as_of"`
	ExportLimit int     `json:"export_limit"`
	Items       []entry `json:"items"`
}

type entry struct {
	ID int64 `json:"ID"`
}

func listAudit(t *testing.T, h *AuthHandler, query string) auditPage {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/auth/admin/audit-logs"+query, nil)
	r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": {"admin.audit.read"}}}))
	w := httptest.NewRecorder()
	h.AdminListAuditLogs(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var page auditPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func pageIDs(p auditPage) []string {
	out := make([]string, 0, len(p.Items))
	for _, e := range p.Items {
		out = append(out, strconv.FormatInt(e.ID, 10))
	}
	return out
}

// Pages read with the first answer's as_of are the rows of that read: rows
// written in between (each read writes one too) neither repeat nor push rows
// off the end, and the total stays.
func TestAdminListAuditLogs_PagesKeepTheFirstRead(t *testing.T) {
	store := &memAuditStore{entries: newestFirst(60)}
	h := &AuthHandler{auditStore: store}

	first := listAudit(t, h, "?limit=25")
	if first.AsOf != 60 || first.Total != 60 || first.ExportLimit != exportMaxRows {
		t.Fatalf("first answer as_of=%d total=%d export_limit=%d, want 60, 60, %d", first.AsOf, first.Total, first.ExportLimit, exportMaxRows)
	}
	seen := pageIDs(first)
	totals := []int{first.Total}
	for _, offset := range []int{25, 50} {
		writeNewer(store, 5)
		p := listAudit(t, h, fmt.Sprintf("?limit=25&offset=%d&as_of=%d", offset, first.AsOf))
		seen = append(seen, pageIDs(p)...)
		totals = append(totals, p.Total)
	}
	if fmt.Sprint(totals) != "[60 60 60]" {
		t.Errorf("totals = %v, want [60 60 60]", totals)
	}
	if r := repeated(seen); len(r) != 0 || len(seen) != 60 || seen[0] != "60" || seen[59] != "1" {
		t.Errorf("pages hold %d rows (first %s, last %s), repeated %v; want 60 to 1 once each", len(seen), seen[0], seen[len(seen)-1], r)
	}

	// A read without as_of (Refresh, Search) sees the rows written since.
	if fresh := listAudit(t, h, "?limit=25"); fresh.AsOf != 70 || fresh.Total != 70 {
		t.Errorf("fresh read as_of=%d total=%d, want 70, 70", fresh.AsOf, fresh.Total)
	}
}

// The CSV holds the rows of its start (or of the screen's as_of) once each,
// however many are written while it pages, and says how many matched.
func TestAdminExportAuditLogs_RowsWrittenDuringTheExport(t *testing.T) {
	store := &memAuditStore{entries: newestFirst(2500), afterList: func(m *memAuditStore) { writeNewer(m, 100) }}
	h := &AuthHandler{auditStore: store}
	w := httptest.NewRecorder()
	h.AdminExportAuditLogs(w, exportRequest(auth.PermissionMatrix{"*": {"admin.audit.export"}}, ""))
	ids := csvIDs(t, w.Body.String())
	if r := repeated(ids); len(r) != 0 || len(ids) != 2500 || ids[0] != "2500" || ids[2499] != "1" {
		t.Errorf("CSV holds %d rows, repeated %d (%v…); want 2500 to 1 once each", len(ids), len(r), r[:min(3, len(r))])
	}
	if got := w.Header().Get("X-Kubeast-Total"); got != "2500" {
		t.Errorf("X-Kubeast-Total = %q, want 2500", got)
	}

	// With the list's as_of: the rows the screen counted, not those written since.
	store = &memAuditStore{entries: newestFirst(1500)}
	h = &AuthHandler{auditStore: store}
	w = httptest.NewRecorder()
	h.AdminExportAuditLogs(w, exportRequest(auth.PermissionMatrix{"*": {"admin.audit.export"}}, "?as_of=1200"))
	if ids := csvIDs(t, w.Body.String()); len(ids) != 1200 || ids[0] != "1200" {
		t.Errorf("as_of=1200: CSV holds %d rows from %s, want 1200 from 1200", len(ids), ids[0])
	}
}

// Past exportMaxRows the CSV holds the newest exportMaxRows and the answer and
// the export's audit row say how many matched; exactly exportMaxRows is whole.
func TestAdminExportAuditLogs_Cut(t *testing.T) {
	for _, tc := range []struct {
		rows      int
		truncated bool
	}{{exportMaxRows + 1, true}, {exportMaxRows, false}} {
		store := &memAuditStore{entries: newestFirst(tc.rows)}
		h := &AuthHandler{auditStore: store}
		w := httptest.NewRecorder()
		h.AdminExportAuditLogs(w, exportRequest(auth.PermissionMatrix{"*": {"admin.audit.export"}}, ""))
		ids := csvIDs(t, w.Body.String())
		var after map[string]interface{}
		_ = json.Unmarshal(store.written[len(store.written)-1].After, &after)
		got := fmt.Sprintf("rows=%d first=%s total=%s after.total=%v after.truncated=%v", len(ids), ids[0], w.Header().Get("X-Kubeast-Total"), after["total"], after["truncated"])
		want := fmt.Sprintf("rows=%d first=%d total=%d after.total=%d after.truncated=%v", exportMaxRows, tc.rows, tc.rows, tc.rows, tc.truncated)
		if got != want {
			t.Errorf("%d matching rows: %s, want %s", tc.rows, got, want)
		}
	}
}
