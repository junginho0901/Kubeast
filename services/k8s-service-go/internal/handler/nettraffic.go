package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nettraffic"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// NetworkTraffic handles GET /api/v1/networktraffic?namespaces=a,b&source=relay|metrics&since=&range=: the
// traffic lines of the Resource Graph — who talks to whom among the workloads of the namespaces — from the
// cluster's Hubble Relay (the recent flows, audited like any flow read) or its Prometheus (the Hubble TCP and
// drop metrics, a metrics read like networkdrops, not audited).
func (h *Handler) NetworkTraffic(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, _ := cluster.FromContext(ctx)
	q := r.URL.Query()
	source := q.Get("source")
	if source != "relay" && source != "metrics" {
		response.Error(w, http.StatusBadRequest, "source must be relay or metrics")
		return
	}
	if source == "relay" && !h.netflows.Configured(ctx, string(id)) {
		response.Error(w, http.StatusNotFound, "network flows are not configured for this cluster")
		return
	}
	if err := h.requirePermissionForCluster(r, "resource.networkflow.read"); err != nil {
		h.handleError(w, err)
		return
	}
	namespaces, err := nettraffic.ParseNamespaces(q.Get("namespaces"))
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	// the namespaces come in the query, so NamespaceScopeMiddleware does not see them
	payload, _ := auth.FromContext(ctx)
	scope := payload.Namespaces[string(id)]
	for _, ns := range namespaces {
		if !payload.AllowedIn(string(id), ns) {
			response.Error(w, http.StatusForbidden, "forbidden: namespace "+ns+" is outside your grant on cluster "+string(id)+" ("+strings.Join(scope, ", ")+")")
			return
		}
	}
	if len(scope) == 0 {
		scope = nil
	}
	if source == "relay" {
		h.networkTrafficRelay(w, r, namespaces, scope)
		return
	}
	h.networkTrafficMetrics(w, r, namespaces, scope)
}

func (h *Handler) networkTrafficRelay(w http.ResponseWriter, r *http.Request, namespaces, scope []string) {
	req := netflows.Request{Namespace: namespaces[0], More: namespaces[1:], Graph: true, Scope: scope, Lookup: h.flowsLookup()}
	var err error
	if req.Since, err = parseSince(r.URL.Query().Get("since")); err == nil {
		err = h.netflows.Normalize(&req)
	}
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	namespace := ""
	if len(namespaces) == 1 {
		namespace = namespaces[0]
	}
	if res := h.relayRead(w, r, req, "namespaces", strings.Join(namespaces, ","), namespace); res != nil {
		response.JSON(w, http.StatusOK, nettraffic.FromFlows(res, namespaces))
	}
}

func (h *Handler) networkTrafficMetrics(w http.ResponseWriter, r *http.Request, namespaces, scope []string) {
	ctx := r.Context()
	rng, err := netdrops.ParseRange(r.URL.Query().Get("range"))
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	unavailable := func(reason string) {
		response.JSON(w, http.StatusOK, nettraffic.Result{Reason: reason, Source: "metrics", Namespaces: namespaces, Range: rng.String(), Lines: []nettraffic.Line{}})
	}
	src := h.netdropsSource()
	if !src.PrometheusAvailable(ctx) {
		unavailable("no_prometheus")
		return
	}
	shapes := map[string]nettraffic.Shape{}
	found := false
	for _, metric := range []string{nettraffic.TCPMetric, netdrops.Metric} {
		labels, err := src.PrometheusLabels(ctx, "", metric, rng, 200)
		if err != nil {
			h.handleError(w, err)
			return
		}
		found = found || len(labels) > 0
		if shape, ok := nettraffic.DetectShape(labels); ok {
			shapes[metric] = shape
		}
	}
	if !found {
		unavailable("no_metrics")
		return
	}
	if len(shapes) == 0 {
		unavailable("no_context_labels")
		return
	}
	rows := map[string][]nettraffic.Sample{}
	for metric, shape := range shapes {
		answer, err := src.PrometheusQuery(ctx, nettraffic.Query(metric, shape, namespaces, rng))
		if err != nil {
			h.handleError(w, err)
			return
		}
		for _, row := range answer {
			labels := make(map[string]string, len(row.Metric))
			for k, v := range row.Metric {
				labels[k] = fmt.Sprint(v)
			}
			rows[metric] = append(rows[metric], nettraffic.Sample{Labels: labels, Value: row.Value})
		}
	}
	tcp, tcpOK := shapes[nettraffic.TCPMetric]
	drop, dropOK := shapes[netdrops.Metric]
	var owners func(namespace, pod string) *netflows.Workload
	if l := h.flowsLookup(); l != nil && (tcp.NoWorkload || drop.NoWorkload) {
		owners = podOwners(ctx, l)
	}
	response.JSON(w, http.StatusOK, nettraffic.FromMetrics(tcp, tcpOK, rows[nettraffic.TCPMetric], drop, dropOK, rows[netdrops.Metric], namespaces, scope, rng, owners))
}

// podOwners names a pod's workload through the lookup, one namespace list at most each (netflows.MaxLookupNamespaces).
func podOwners(ctx context.Context, l netflows.Lookup) func(namespace, pod string) *netflows.Workload {
	byNamespace := map[string]map[string]netflows.Workload{}
	return func(namespace, pod string) *netflows.Workload {
		m, ok := byNamespace[namespace]
		if !ok && len(byNamespace) < netflows.MaxLookupNamespaces {
			m, _ = l.Workloads(ctx, namespace)
			byNamespace[namespace] = m
		}
		if w, ok := m[pod]; ok {
			return &w
		}
		return nil
	}
}
