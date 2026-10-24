package handler

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// netdropsSource is what a drops read needs: the cluster's Prometheus and the target's workload and pods,
// all as the signed-in user (*k8s.Service; tests replace it).
type netdropsSource interface {
	PrometheusAvailable(ctx context.Context) bool
	PrometheusLabels(ctx context.Context, label, selector string, since time.Duration, limit int) ([]string, error)
	PrometheusQuery(ctx context.Context, query string) ([]k8s.PrometheusQueryResult, error)
	NetdropsTarget(ctx context.Context, namespace, kind, name string, wantPods bool) (*netdrops.Workload, []string, bool, error)
}

func (h *Handler) netdropsSource() netdropsSource {
	if h.netdropsSrc != nil {
		return h.netdropsSrc
	}
	return h.svc
}

// NetworkDrops handles GET /api/v1/namespaces/{namespace}/networkdrops?kind=&name=&range=: the Hubble drops
// of the namespace, or of one pod or workload in it, from the cluster's Prometheus — how many, why, and from
// or to whom. A metrics read like the drawer graphs and prometheus_query, so it is not audited.
func (h *Handler) NetworkDrops(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := h.requirePermissionForCluster(r, "resource.networkflow.read"); err != nil {
		h.handleError(w, err)
		return
	}
	q := r.URL.Query()
	rng, err := netdrops.ParseRange(q.Get("range"))
	req := netdrops.Request{Namespace: chi.URLParam(r, "namespace"), Kind: q.Get("kind"), Name: q.Get("name"), Range: rng}
	if err == nil {
		err = req.Validate()
	}
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	id, _ := cluster.FromContext(ctx)
	payload, _ := auth.FromContext(ctx)
	if scope := payload.Namespaces[string(id)]; len(scope) > 0 {
		req.Scope = scope
	}
	src := h.netdropsSource()
	unavailable := func(reason string) {
		response.JSON(w, http.StatusOK, netdrops.Result{Reason: reason, Namespace: req.Namespace, Kind: req.Kind, Name: req.Name, Range: rng.String()})
	}
	if !src.PrometheusAvailable(ctx) {
		unavailable("no_prometheus")
		return
	}
	labels, err := src.PrometheusLabels(ctx, "", netdrops.Metric, rng, 200)
	if err != nil {
		h.handleError(w, err)
		return
	}
	if len(labels) == 0 {
		unavailable("no_metrics")
		return
	}
	shape, ok := netdrops.DetectShape(labels)
	if !ok {
		unavailable("no_context_labels")
		return
	}
	if req.Kind != "" {
		wantPods := shape.Style == netdrops.StylePod && req.Kind != "Pod"
		req.Workload, req.Pods, req.PodsTruncated, err = src.NetdropsTarget(ctx, req.Namespace, req.Kind, req.Name, wantPods)
		if err != nil {
			h.handleError(w, err)
			return
		}
	}
	queries, notes := netdrops.Plan(shape, req)
	answers := map[string][]netdrops.Sample{}
	for _, query := range queries {
		rows, err := src.PrometheusQuery(ctx, query.Expr)
		if err != nil {
			h.handleError(w, err)
			return
		}
		for _, row := range rows {
			labels := make(map[string]string, len(row.Metric))
			for k, v := range row.Metric {
				labels[k] = fmt.Sprint(v)
			}
			answers[query.Side] = append(answers[query.Side], netdrops.Sample{Labels: labels, Value: row.Value})
		}
	}
	response.JSON(w, http.StatusOK, netdrops.Assemble(shape, req, notes, answers))
}
