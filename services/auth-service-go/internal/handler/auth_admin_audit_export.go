package handler

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// exportMaxRows bounds one CSV export; the list filter narrows the range.
const exportMaxRows = 50000

var exportColumns = []string{
	"id", "created_at", "service", "action", "result", "error",
	"actor_email", "actor_user_id", "cluster", "namespace",
	"target_type", "target_id", "target_email",
	"request_ip", "request_id", "path", "before", "after",
}

// AdminExportAuditLogs handles GET /auth/admin/audit-logs/export: the same
// filter query params as the list, streamed as CSV (RFC 4180, UTF-8 with BOM
// so spreadsheets open non-ASCII text correctly). Requires the
// admin.audit.export permission and records the export itself.
func (h *AuthHandler) AdminExportAuditLogs(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(h.auditStore, w, r, "admin.audit.export")
	if !ok {
		return
	}
	filter := auditFilterFromQuery(r)
	filter.Limit = 1000
	filter.Offset = 0

	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAdmin
	rec.Action = "admin.audit.export"
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.TargetType = "audit-logs"

	// Collect first so a store error becomes a JSON 500 instead of a truncated file.
	var rows []audit.Entry
	for len(rows) < exportMaxRows {
		page, _, err := h.auditStore.List(r.Context(), filter)
		if err != nil {
			rec.Result = audit.ResultFailure
			rec.Error = err.Error()
			_, _ = h.auditStore.Write(r.Context(), rec)
			response.InternalError(w, r, err)
			return
		}
		rows = append(rows, page...)
		if len(page) < filter.Limit {
			break
		}
		filter.Offset += len(page)
	}
	if len(rows) > exportMaxRows {
		rows = rows[:exportMaxRows]
	}

	rec.After = audit.MustJSON(map[string]interface{}{
		"filter":    filter,
		"rows":      len(rows),
		"truncated": len(rows) == exportMaxRows,
	})
	_, _ = h.auditStore.Write(r.Context(), rec)

	name := "audit-logs-" + time.Now().UTC().Format("20060102-150405") + ".csv"
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF}) // UTF-8 BOM
	cw := csv.NewWriter(w)
	cw.UseCRLF = true
	_ = cw.Write(exportColumns)
	for _, e := range rows {
		_ = cw.Write(csvCells(
			strconv.FormatInt(e.ID, 10), e.CreatedAt.UTC().Format(time.RFC3339), e.Service, e.Action, e.Result, e.Error,
			e.ActorEmail, e.ActorUserID, e.Cluster, e.Namespace,
			e.TargetType, e.TargetID, e.TargetEmail,
			e.RequestIP, e.RequestID, e.Path, string(e.Before), string(e.After),
		))
	}
	cw.Flush()
}

// csvCells neutralises spreadsheet formulas: a cell that starts with one of
// the characters a spreadsheet treats as a formula or field separator gets a
// leading apostrophe (OWASP CSV Injection). Audit columns carry user input —
// a failed login stores the submitted email as target_email, for one — so
// every cell goes through it. encoding/csv quotes and escapes the rest.
func csvCells(cells ...string) []string {
	for i, c := range cells {
		if c != "" && strings.ContainsRune("=+-@\t\r", rune(c[0])) {
			cells[i] = "'" + c
		}
	}
	return cells
}

// auditFilterFromQuery reads the list/export filter query params.
func auditFilterFromQuery(r *http.Request) audit.Filter {
	q := r.URL.Query()
	filter := audit.Filter{
		Service:    q.Get("service"),
		Action:     q.Get("action"),
		ActorEmail: q.Get("actor_email"),
		TargetID:   q.Get("target_id"),
		Cluster:    q.Get("cluster"),
		Namespace:  q.Get("namespace"),
		Result:     q.Get("result"),
		Limit:      queryInt(r, "limit", 100),
		Offset:     queryInt(r, "offset", 0),
	}
	if s := q.Get("since"); s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			filter.Since = t
		}
	}
	if s := q.Get("until"); s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			filter.Until = t
		}
	}
	return filter
}
