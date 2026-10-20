package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/alerts"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// SetAlertStore turns on alert reads (chart features.alertStore).
func (h *Handler) SetAlertStore(s *alerts.Store) { h.alertStore = s }

// alertStoreFeature is the /cluster/features entry: the clusters with alert reads, and whether silences can be made.
func (h *Handler) alertStoreFeature() map[string]interface{} {
	if h.alertStore == nil {
		return map[string]interface{}{"enabled": false, "clusters": []string{}, "silences": false}
	}
	cfg := h.alertStore.Config()
	return map[string]interface{}{"enabled": true, "clusters": cfg.ClusterIDs(), "clusterLabel": cfg.ClusterLabel,
		"silences": cfg.SilencesEnabled, "silenceMaxHours": int(cfg.SilenceMaxDuration.Hours())}
}

// alertStoreGate passes a caller who holds perm on the request's cluster as a whole (alerts and silences cover
// the whole cluster, so a grant limited to namespaces is refused) and returns the cluster ID and the caller.
func (h *Handler) alertStoreGate(w http.ResponseWriter, r *http.Request, perm string) (string, auth.TokenPayload, bool) {
	id, _ := cluster.FromContext(r.Context())
	if !h.alertStore.Configured(r.Context(), string(id)) {
		response.Error(w, http.StatusNotFound, "alert store is not configured for this cluster")
		return "", auth.TokenPayload{}, false
	}
	if err := h.requirePermissionForCluster(r, perm); err != nil {
		h.handleError(w, err)
		return "", auth.TokenPayload{}, false
	}
	payload, _ := auth.FromContext(r.Context())
	if len(payload.Namespaces[string(id)]) > 0 {
		response.Error(w, http.StatusForbidden, "alerts cover the whole cluster; your grant on this cluster is limited to namespaces ("+strings.Join(payload.Namespaces[string(id)], ", ")+")")
		return "", auth.TokenPayload{}, false
	}
	return string(id), payload, true
}

// alertStoreError answers a store error with the status that says why.
func alertStoreError(w http.ResponseWriter, err error) {
	var se *alerts.StoreError
	status := http.StatusBadGateway
	switch {
	case errors.Is(err, alerts.ErrInvalidRequest):
		status = http.StatusBadRequest
	case errors.Is(err, alerts.ErrSilencesOff), errors.Is(err, alerts.ErrNotFound), errors.Is(err, alerts.ErrNotConfigured):
		status = http.StatusNotFound
	case errors.Is(err, alerts.ErrNotServed):
		status, err = http.StatusNotFound, fmt.Errorf("the alert store's API is %w (an Alertmanager API v2 at the configured URL?)", err)
	case errors.Is(err, alerts.ErrTimeout):
		status = http.StatusGatewayTimeout
	case errors.As(err, &se) && se.Status == http.StatusBadRequest:
		status = http.StatusBadRequest
	case errors.As(err, &se) && (se.Status == http.StatusUnauthorized || se.Status == http.StatusForbidden):
		err = fmt.Errorf("the alert store refused the write (its credentials need write access to silences): %w", err)
	}
	response.Error(w, status, err.Error())
}

// AlertStoreAlerts handles GET /api/v1/alertstore/alerts?state=&alertname=&label=name=value…:
// the cluster's alerts in the alert store and the silences on them. Alerts
// cover the whole cluster (nodes, the control plane), so a grant limited to
// namespaces is refused, as for the Prometheus reads. A plain read: no audit row.
func (h *Handler) AlertStoreAlerts(w http.ResponseWriter, r *http.Request) {
	id, payload, ok := h.alertStoreGate(w, r, "resource.pod.read")
	if !ok {
		return
	}
	q := r.URL.Query()
	query := alerts.Query{State: q.Get("state"), AlertName: strings.TrimSpace(q.Get("alertname")), Labels: map[string]string{}}
	for _, pair := range q["label"] {
		name, value, ok := strings.Cut(pair, "=")
		if !ok {
			response.Error(w, http.StatusBadRequest, fmt.Sprintf("label %q: name=value", pair))
			return
		}
		query.Labels[strings.TrimSpace(name)] = value
	}
	if err := query.Check(); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if !h.allowAlertRead(w, payload) {
		return
	}
	res, err := h.alertStore.List(r.Context(), id, query)
	if err != nil {
		alertStoreError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, res)
}

// AlertStoreSilences handles GET /api/v1/alertstore/silences: the cluster's active and pending silences. A plain read.
func (h *Handler) AlertStoreSilences(w http.ResponseWriter, r *http.Request) {
	id, payload, ok := h.alertStoreGate(w, r, "resource.pod.read")
	if !ok || !h.allowAlertRead(w, payload) {
		return
	}
	out, err := h.alertStore.Silences(r.Context(), id)
	if err != nil {
		alertStoreError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"silences": out})
}

// AlertStoreSilencePreview handles GET /api/v1/alertstore/silences/preview?matchers=<JSON list>: the cluster's
// alerts a silence with those conditions would mute now (the cluster condition added). A plain read.
func (h *Handler) AlertStoreSilencePreview(w http.ResponseWriter, r *http.Request) {
	id, payload, ok := h.alertStoreGate(w, r, "resource.pod.read")
	if !ok {
		return
	}
	var ms []alerts.Matcher
	if err := json.Unmarshal([]byte(r.URL.Query().Get("matchers")), &ms); err != nil {
		response.Error(w, http.StatusBadRequest, "matchers: a JSON list of {name, value, isRegex, isEqual}")
		return
	}
	if !h.allowAlertRead(w, payload) {
		return
	}
	res, err := h.alertStore.Preview(r.Context(), id, ms)
	if err != nil {
		alertStoreError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, res)
}

type silenceIn struct {
	Matchers        []alerts.Matcher `json:"matchers"`
	DurationMinutes int              `json:"durationMinutes"`
	Comment         string           `json:"comment"`
}

// CreateAlertSilence handles POST /api/v1/alertstore/silences (resource.alert.silence, features.alertStore.silences):
// a silence in the alert store with the cluster condition added, created by the caller. Audited as
// alert.silence.create, refused and failed ones too.
func (h *Handler) CreateAlertSilence(w http.ResponseWriter, r *http.Request) {
	id, payload, ok := h.alertStoreGate(w, r, "resource.alert.silence")
	if !ok {
		return
	}
	var in silenceIn
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		response.Error(w, http.StatusBadRequest, "body: {matchers, durationMinutes, comment}")
		return
	}
	req := alerts.SilenceRequest{Matchers: in.Matchers, Duration: time.Duration(in.DurationMinutes) * time.Minute, Comment: in.Comment}
	now := time.Now()
	sid, matchers, err := h.alertStore.Create(r.Context(), id, req, payload.Email, now)
	conditions := make([]string, 0, len(matchers))
	for _, m := range matchers {
		conditions = append(conditions, m.String())
	}
	after := audit.MustJSON(map[string]interface{}{
		"matchers": conditions, "duration_minutes": in.DurationMinutes, "comment": strings.TrimSpace(in.Comment),
		"ends_at": now.Add(req.Duration).UTC().Format(time.RFC3339),
	})
	h.recordAuditWithPayload(r, "alert.silence.create", "silence", sid, "", err, nil, after)
	if err != nil {
		alertStoreError(w, err)
		return
	}
	response.JSON(w, http.StatusCreated, map[string]interface{}{"silenceID": sid, "matchers": conditions})
}

// ExpireAlertSilence handles DELETE /api/v1/alertstore/silences/{id} (resource.alert.silence): ends one of the
// cluster's silences now — one without the cluster condition is not found. Audited as alert.silence.expire.
func (h *Handler) ExpireAlertSilence(w http.ResponseWriter, r *http.Request) {
	id, _, ok := h.alertStoreGate(w, r, "resource.alert.silence")
	if !ok {
		return
	}
	sid := chi.URLParam(r, "silenceID")
	sl, err := h.alertStore.Expire(r.Context(), id, sid)
	var after json.RawMessage
	if err == nil {
		after = audit.MustJSON(map[string]interface{}{"matchers": sl.Matchers, "comment": sl.Comment, "created_by": sl.CreatedBy, "ends_at": sl.EndsAt})
	}
	h.recordAuditWithPayload(r, "alert.silence.expire", "silence", sid, "", err, nil, after)
	if err != nil {
		alertStoreError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"expired": sid})
}

// allowAlertRead takes one read from the caller's per-minute budget.
func (h *Handler) allowAlertRead(w http.ResponseWriter, payload auth.TokenPayload) bool {
	if h.alertStore.Allow(payload.UserID) {
		return true
	}
	response.Error(w, http.StatusTooManyRequests, fmt.Sprintf("too many alert reads: %d per minute", h.alertStore.Config().PerUserPerMinute))
	return false
}
