package handler

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Finding what the cluster's Prometheus holds (the AI's discovery tools read
// these): GET /api/v1/prometheus/{metrics,labels,rules,targets}. Reads like the
// queries — no audit row, the caller's identity on an in-cluster Prometheus.

const (
	promNamesDefault = 50
	promNamesMax     = 200
	promValuesMax    = 200
	promMaxWindow    = 7 * 24 * time.Hour
)

// A label name as Prometheus writes it, plus the dots of untranslated OTel names.
var promLabelName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$`)

func boundedInt(raw string, def, max int) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

func (h *Handler) promUnavailable(w http.ResponseWriter, r *http.Request) bool {
	if h.svc.PrometheusAvailable(r.Context()) {
		return false
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"available": false})
	return true
}

// PrometheusMetrics — metric names seen in the last hour containing ?pattern=,
// up to ?limit= (default 50, max 200), with type, help and unit when the store
// keeps metadata.
func (h *Handler) PrometheusMetrics(w http.ResponseWriter, r *http.Request) {
	if h.promUnavailable(w, r) {
		return
	}
	limit := boundedInt(r.URL.Query().Get("limit"), promNamesDefault, promNamesMax)
	metrics, total, err := h.svc.PrometheusMetricNames(r.Context(), r.URL.Query().Get("pattern"), limit)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"available": true, "metrics": metrics, "total": total, "truncated": total > len(metrics),
	})
}

// PrometheusLabels — label names on the series ?selector= matches, or the
// values of ?label=, within ?since= (default 1h, max 7d), up to ?limit=
// (default and max 200).
func (h *Handler) PrometheusLabels(w http.ResponseWriter, r *http.Request) {
	if h.promUnavailable(w, r) {
		return
	}
	q := r.URL.Query()
	label := strings.TrimSpace(q.Get("label"))
	if label != "" && !promLabelName.MatchString(label) {
		response.Error(w, http.StatusBadRequest, "label: not a label name")
		return
	}
	since := time.Hour
	if v := q.Get("since"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			response.Error(w, http.StatusBadRequest, "since must be a positive duration")
			return
		}
		since = min(d, promMaxWindow)
	}
	limit := boundedInt(q.Get("limit"), promValuesMax, promValuesMax)
	vals, err := h.svc.PrometheusLabels(r.Context(), label, q.Get("selector"), since, limit)
	if err != nil {
		h.handleError(w, err)
		return
	}
	truncated := len(vals) > limit
	if truncated {
		vals = vals[:limit]
	}
	key := "names"
	if label != "" {
		key = "values"
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"available": true, "label": label, key: vals, "truncated": truncated, "since": since.String(),
	})
}

// PrometheusRules — alerting and recording rules (?type=alert|record, ?rule=
// part of the name) with their active alerts; on a shared store the alerts are
// this cluster's only and "shared" says the rules may cover every cluster.
func (h *Handler) PrometheusRules(w http.ResponseWriter, r *http.Request) {
	if h.promUnavailable(w, r) {
		return
	}
	ruleType := r.URL.Query().Get("type")
	if ruleType != "" && ruleType != "alert" && ruleType != "record" {
		response.Error(w, http.StatusBadRequest, "type must be alert or record")
		return
	}
	rules, shared, err := h.svc.PrometheusRules(r.Context(), ruleType, r.URL.Query().Get("rule"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"available": true, "rules": rules, "shared": shared})
}

// PrometheusTargets — scrape targets and their health; source says whether
// they came from the targets API or from the `up` series.
func (h *Handler) PrometheusTargets(w http.ResponseWriter, r *http.Request) {
	if h.promUnavailable(w, r) {
		return
	}
	targets, source, err := h.svc.PrometheusTargets(r.Context())
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"available": true, "targets": targets, "source": source})
}
