package handler

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/alerts"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// SetAlertStore turns on alert reads (chart features.alertStore).
func (h *Handler) SetAlertStore(s *alerts.Store) { h.alertStore = s }

// alertStoreFeature is the /cluster/features entry: the clusters with alert reads.
func (h *Handler) alertStoreFeature() map[string]interface{} {
	if h.alertStore == nil {
		return map[string]interface{}{"enabled": false, "clusters": []string{}}
	}
	return map[string]interface{}{"enabled": true, "clusters": h.alertStore.Config().ClusterIDs()}
}

// AlertStoreAlerts handles GET /api/v1/alertstore/alerts?state=&alertname=&label=name=value…:
// the cluster's alerts in the alert store and the silences on them. Alerts
// cover the whole cluster (nodes, the control plane), so a grant limited to
// namespaces is refused, as for the Prometheus reads. A plain read: no audit row.
func (h *Handler) AlertStoreAlerts(w http.ResponseWriter, r *http.Request) {
	id, _ := cluster.FromContext(r.Context())
	if !h.alertStore.Configured(r.Context(), string(id)) {
		response.Error(w, http.StatusNotFound, "alert store is not configured for this cluster")
		return
	}
	if err := h.requirePermissionForCluster(r, "resource.pod.read"); err != nil {
		h.handleError(w, err)
		return
	}
	payload, _ := auth.FromContext(r.Context())
	if len(payload.Namespaces[string(id)]) > 0 {
		response.Error(w, http.StatusForbidden, "alerts cover the whole cluster; your grant on this cluster is limited to namespaces ("+strings.Join(payload.Namespaces[string(id)], ", ")+")")
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
	if !h.alertStore.Allow(payload.UserID) {
		response.Error(w, http.StatusTooManyRequests, fmt.Sprintf("too many alert reads: %d per minute", h.alertStore.Config().PerUserPerMinute))
		return
	}
	res, err := h.alertStore.List(r.Context(), string(id), query)
	if err != nil {
		var se *alerts.StoreError
		status := http.StatusBadGateway
		switch {
		case errors.Is(err, alerts.ErrInvalidRequest):
			status = http.StatusBadRequest
		case errors.Is(err, alerts.ErrNotServed):
			status, err = http.StatusNotFound, fmt.Errorf("the alert store's alerts API is %w (an Alertmanager API v2 at the configured URL?)", err)
		case errors.Is(err, alerts.ErrNotConfigured):
			status = http.StatusNotFound
		case errors.Is(err, alerts.ErrTimeout):
			status = http.StatusGatewayTimeout
		case errors.As(err, &se) && se.Status == http.StatusBadRequest:
			status = http.StatusBadRequest
		}
		response.Error(w, status, err.Error())
		return
	}
	response.JSON(w, http.StatusOK, res)
}
