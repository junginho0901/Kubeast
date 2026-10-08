package handler

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/hygiene"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Cluster hygiene report (k8s.CollectHygiene) for the cluster in ?cluster=:
//
//   GET  /api/v1/hygiene/config          enabled, interval_days
//   GET  /api/v1/hygiene                 report + last sign-off      admin.hygiene.read,   audited k8s.hygiene.scan
//   GET  /api/v1/hygiene?format=csv|json download                    admin.hygiene.export, audited admin.hygiene.export
//   POST /api/v1/hygiene/signoff {note}  store the report as signed  admin.hygiene.signoff
//   GET  /api/v1/hygiene/history         sign-offs, newest first     admin.hygiene.read
//   GET  /api/v1/hygiene/snapshot/{id}   one sign-off with its report admin.hygiene.read
//
// The scan runs as the caller (impersonation); a list the caller cannot read
// becomes a Collector entry. Reading TLS Secrets makes every scan a sensitive
// read: it is refused while the audit store cannot record it.

const (
	permHygieneRead    = "admin.hygiene.read"
	permHygieneExport  = "admin.hygiene.export"
	permHygieneSignoff = "admin.hygiene.signoff"
	hygieneNoteMax     = 2000
	hygieneHistoryMax  = 100
)

// SetHygieneStore wires the sign-off store (hygiene_reviews).
func (h *Handler) SetHygieneStore(s hygiene.Store) { h.hygieneStore = s }

type hygieneResponse struct {
	Cluster      string            `json:"cluster"`
	IntervalDays int               `json:"interval_days"`
	LastReview   *hygiene.Review   `json:"last_review"`
	NextDue      *string           `json:"next_due"`
	Due          bool              `json:"due"`
	Report       k8s.HygieneReport `json:"report"`
}

func (h *Handler) HygieneConfig(w http.ResponseWriter, r *http.Request) {
	response.JSON(w, http.StatusOK, map[string]interface{}{"enabled": h.cfg.HygieneEnabled, "interval_days": h.cfg.HygieneIntervalDays})
}

func (h *Handler) hygieneAllowed(w http.ResponseWriter, r *http.Request, perm string) bool {
	if !h.cfg.HygieneEnabled {
		response.Error(w, http.StatusNotFound, "cluster hygiene report is disabled")
		return false
	}
	if err := h.requirePermission(r, perm); err != nil {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return false
	}
	return true
}

func hygieneClusterID(r *http.Request) string {
	if id, ok := cluster.FromContext(r.Context()); ok && id != "" {
		return string(id)
	}
	return "default"
}

func (h *Handler) collectHygiene(r *http.Request) (k8s.HygieneReport, error) {
	opts := k8s.HygieneOptions{
		ExcludeNamespaces: h.cfg.HygieneExcludeNamespaces,
		TLSWarnDays:       h.cfg.HygieneTLSWarnDays,
		TLSCriticalDays:   h.cfg.HygieneTLSCriticalDays,
		Now:               time.Now(),
	}
	if h.hygieneScan != nil {
		return h.hygieneScan(r.Context(), opts)
	}
	return h.svc.CollectHygiene(r.Context(), opts)
}

func hygieneAuditAfter(rep k8s.HygieneReport, extra map[string]interface{}) json.RawMessage {
	after := map[string]interface{}{"counts": rep.Counts, "findings": len(rep.Findings), "collector_failures": len(rep.Collectors)}
	for k, v := range extra {
		after[k] = v
	}
	return audit.MustJSON(after)
}

// GetHygiene returns the report, or with format=csv|json a download of it.
func (h *Handler) GetHygiene(w http.ResponseWriter, r *http.Request) {
	format := r.URL.Query().Get("format")
	perm, action, service := permHygieneRead, "k8s.hygiene.scan", audit.ServiceK8s
	if format != "" {
		if format != "csv" && format != "json" {
			response.Error(w, http.StatusBadRequest, "format must be csv or json")
			return
		}
		perm, action, service = permHygieneExport, "admin.hygiene.export", audit.ServiceAdmin
	}
	if !h.hygieneAllowed(w, r, perm) {
		return
	}
	if err := h.auditReady(r); err != nil {
		h.refuseUnaudited(w, r, err)
		return
	}
	clusterID := hygieneClusterID(r)
	rep, err := h.collectHygiene(r)
	extra := map[string]interface{}{}
	if format != "" {
		extra["format"] = format
	}
	if werr := h.recordAuditAs(r, service, action, "cluster", clusterID, "", err, nil, hygieneAuditAfter(rep, extra)); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	if err != nil {
		h.handleError(w, err)
		return
	}
	filename := "hygiene-" + clusterID + "-" + time.Now().UTC().Format("20060102")
	switch format {
	case "csv":
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`.csv"`)
		writeHygieneCSV(w, rep)
		return
	case "json":
		w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`.json"`)
		response.JSON(w, http.StatusOK, map[string]interface{}{"cluster": clusterID, "report": rep})
		return
	}
	resp := hygieneResponse{Cluster: clusterID, IntervalDays: h.cfg.HygieneIntervalDays, Report: rep, Due: true}
	if h.hygieneStore != nil {
		if list, lerr := h.hygieneStore.List(r.Context(), clusterID, 1); lerr == nil && len(list) == 1 {
			last := list[0]
			resp.LastReview = &last
			due := last.ReviewedAt.AddDate(0, 0, h.cfg.HygieneIntervalDays).UTC()
			s := due.Format(time.RFC3339)
			resp.NextDue, resp.Due = &s, time.Now().After(due)
		}
	}
	response.JSON(w, http.StatusOK, resp)
}

type hygieneSignoffRequest struct {
	Note string `json:"note"`
}

// SignoffHygiene stores the cluster's report as it stands now, with who signed.
func (h *Handler) SignoffHygiene(w http.ResponseWriter, r *http.Request) {
	if !h.hygieneAllowed(w, r, permHygieneSignoff) {
		return
	}
	if h.hygieneStore == nil {
		response.Error(w, http.StatusServiceUnavailable, "hygiene sign-off store unavailable")
		return
	}
	var req hygieneSignoffRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			response.Error(w, http.StatusBadRequest, "Invalid JSON body")
			return
		}
	}
	note := strings.TrimSpace(req.Note)
	if len(note) > hygieneNoteMax {
		response.Error(w, http.StatusBadRequest, "note must be at most "+strconv.Itoa(hygieneNoteMax)+" characters")
		return
	}
	clusterID := hygieneClusterID(r)
	rep, err := h.collectHygiene(r)
	if err != nil {
		_ = h.recordAuditAs(r, audit.ServiceAdmin, "admin.hygiene.signoff", "hygiene_review", "", "", err, nil, audit.MustJSON(map[string]interface{}{"cluster": clusterID}))
		h.handleError(w, err)
		return
	}
	payload, _ := auth.FromContext(r.Context())
	rev := &hygiene.Review{
		ID: uuid.NewString(), Cluster: clusterID, ReviewedByEmail: payload.Email, ReviewedAt: time.Now().UTC(), Note: note,
		Counts: audit.MustJSON(rep.Counts), Snapshot: audit.MustJSON(map[string]interface{}{"cluster": clusterID, "report": rep}),
	}
	if payload.UserID != "" {
		uid := payload.UserID
		rev.ReviewedBy = &uid
	}
	cerr := h.hygieneStore.Create(r.Context(), rev)
	_ = h.recordAuditAs(r, audit.ServiceAdmin, "admin.hygiene.signoff", "hygiene_review", rev.ID, "", cerr, nil,
		hygieneAuditAfter(rep, map[string]interface{}{"note": note}))
	if cerr != nil {
		response.InternalError(w, r, cerr)
		return
	}
	rev.Snapshot = nil
	response.JSON(w, http.StatusCreated, rev)
}

// HygieneHistory lists the cluster's sign-offs, newest first.
func (h *Handler) HygieneHistory(w http.ResponseWriter, r *http.Request) {
	if !h.hygieneAllowed(w, r, permHygieneRead) {
		return
	}
	if h.hygieneStore == nil {
		response.JSON(w, http.StatusOK, []hygiene.Review{})
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > hygieneHistoryMax {
		limit = hygieneHistoryMax
	}
	list, err := h.hygieneStore.List(r.Context(), hygieneClusterID(r), limit)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, list)
}

// HygieneSnapshot returns one sign-off of the cluster with its report.
func (h *Handler) HygieneSnapshot(w http.ResponseWriter, r *http.Request) {
	if !h.hygieneAllowed(w, r, permHygieneRead) {
		return
	}
	if h.hygieneStore == nil {
		response.Error(w, http.StatusNotFound, "hygiene review not found")
		return
	}
	if err := h.auditReady(r); err != nil {
		h.refuseUnaudited(w, r, err)
		return
	}
	id := chi.URLParam(r, "id")
	rev, err := h.hygieneStore.Get(r.Context(), hygieneClusterID(r), id)
	if errors.Is(err, hygiene.ErrNotFound) {
		response.Error(w, http.StatusNotFound, "hygiene review not found")
		return
	}
	if werr := h.recordAuditAs(r, audit.ServiceAdmin, "admin.hygiene.read", "hygiene_review", id, "", err, nil,
		audit.MustJSON(map[string]interface{}{"snapshot": true})); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, rev)
}

// writeHygieneCSV writes the findings as a spreadsheet-friendly file (UTF-8
// BOM, CRLF); a cell starting with a formula character gets a leading
// apostrophe (OWASP CSV Injection) — names and messages come from the cluster.
func writeHygieneCSV(w io.Writer, rep k8s.HygieneReport) {
	refs := map[string]string{}
	for _, c := range rep.Checks {
		refs[c.ID] = c.Refs
	}
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})
	cw := csv.NewWriter(w)
	cw.UseCRLF = true
	_ = cw.Write([]string{"check", "severity", "kind", "namespace", "name", "container", "pods", "message", "exempt", "exempt_reason", "refs", "generated_at"})
	for _, f := range rep.Findings {
		pods := ""
		if f.Pods > 0 {
			pods = strconv.Itoa(f.Pods)
		}
		_ = cw.Write(hygieneCSVCells(f.Check, f.Severity, f.Kind, f.Namespace, f.Name, f.Container, pods, f.Message,
			strconv.FormatBool(f.Exempt), f.ExemptReason, refs[f.Check], rep.GeneratedAt))
	}
	cw.Flush()
}

func hygieneCSVCells(cells ...string) []string {
	for i, c := range cells {
		if c != "" && strings.ContainsRune("=+-@\t\r", rune(c[0])) {
			cells[i] = "'" + c
		}
	}
	return cells
}
