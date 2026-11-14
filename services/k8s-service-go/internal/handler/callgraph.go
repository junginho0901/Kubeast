package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/callgraph"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nettraffic"
)

// callGraphNamespaceAttribute is the trace resource attribute a service graph metric's client_/server_ namespace labels
// come from (OpenTelemetry's k8s.namespace.name, the trace store's default).
const callGraphNamespaceAttribute = "k8s.namespace.name"

// resourceGraphCalls is the calls part of a namespace's graph (include=calls): who calls whom over rng from the traces'
// service graph metrics and the Hubble metrics, both in the cluster's Prometheus and read as the user, placed on the
// graph's boxes, with the failing workloads ordered and the paths between them. Each source that could not be read
// says why; a source's failure does not fail the graph. At most 1 + 3 queries for the traces and the traffic lines'
// reads (3 or 4).
func (h *Handler) resourceGraphCalls(r *http.Request, namespace string, graph map[string]interface{}, rangeParam string) (callgraph.Result, error) {
	if !h.cfg.CallGraphEnabled {
		return callgraph.Off(), nil
	}
	rng, err := netdrops.ParseRange(rangeParam)
	if err != nil {
		return callgraph.Result{}, fmt.Errorf("%w: %s", k8s.ErrBadInput, err.Error())
	}
	if !callgraph.ValidNamespace(namespace) {
		return callgraph.Result{}, fmt.Errorf("%w: namespace %q", k8s.ErrBadInput, namespace)
	}
	ctx := r.Context()
	ix, err := callGraphIndex(namespace, graph)
	if err != nil {
		return callgraph.Result{}, err
	}
	res := callgraph.Result{Available: true, Range: rng.String(), Sources: []callgraph.SourceState{}}

	traces, state := h.callGraphTraces(ctx, r, namespace, rng)
	res.Sources = append(res.Sources, state)

	var lines []nettraffic.Line
	netState := callgraph.SourceState{Source: callgraph.SourceNetwork}
	scope := promScope(r)
	if len(scope) == 0 {
		scope = nil
	}
	switch {
	case !h.canForCluster(r, "resource.networkflow.read"):
		netState.Reason = callgraph.ReasonPermission
		netState.Detail = "the traffic lines ask resource.networkflow.read"
	default:
		t, err := h.trafficFromMetrics(ctx, []string{namespace}, scope, rng)
		switch {
		case err != nil:
			netState.Reason, netState.Detail = callgraph.ReasonFailed, err.Error()
		case !t.Available:
			netState.Reason = t.Reason
		default:
			netState.Read, netState.Series, lines = true, len(t.Lines), t.Lines
		}
	}
	res.Sources = append(res.Sources, netState)

	res.Edges, res.EdgesTotal, res.Truncated = callgraph.Build(ix, traces, lines)
	rk := callgraph.Suspects(ix, res.Edges)
	res.Suspects, res.SuspectsTotal, res.Paths, res.NoStart = rk.Suspects, rk.Total, rk.Paths, rk.NoStart
	if res.Suspects == nil {
		res.Suspects = []callgraph.Suspect{}
	}
	if res.Paths == nil {
		res.Paths = [][]string{}
	}
	return res, nil
}

// callGraphTraces reads the service graph metrics: the label names, then requests, failed requests and the 90th
// percentile. A grant limited to namespaces reads none of them, as the Prometheus screens refuse it: a metric without
// namespace labels names every namespace's services.
func (h *Handler) callGraphTraces(ctx context.Context, r *http.Request, namespace string, rng time.Duration) (*callgraph.Traces, callgraph.SourceState) {
	state := callgraph.SourceState{Source: callgraph.SourceTraces}
	src := h.netdropsSource()
	if len(promScope(r)) > 0 {
		state.Reason = callgraph.ReasonNamespaceLimited
		return nil, state
	}
	if !src.PrometheusAvailable(ctx) {
		state.Reason = callgraph.ReasonNoPrometheus
		return nil, state
	}
	labels, err := src.PrometheusLabels(ctx, "", callgraph.RequestsMetric, rng, 200)
	if err != nil {
		state.Reason, state.Detail = callgraph.ReasonFailed, err.Error()
		return nil, state
	}
	shape, ok := callgraph.DetectShape(labels, callGraphNamespaceAttribute)
	if !ok {
		state.Reason = callgraph.ReasonNoMetrics
		return nil, state
	}
	q := callgraph.BuildQueries(shape, namespace, rng)
	tr := &callgraph.Traces{Shape: shape}
	for _, read := range []struct {
		query string
		into  *[]callgraph.Sample
	}{{q.Requests, &tr.Requests}, {q.Failed, &tr.Failed}, {q.P90, &tr.P90}} {
		answer, err := src.PrometheusQuery(ctx, read.query)
		if err != nil {
			state.Reason, state.Detail = callgraph.ReasonFailed, err.Error()
			return nil, state
		}
		*read.into = callGraphSamples(answer)
	}
	state.Read, state.Series = true, len(tr.Requests)
	if shape.Namespace == "" {
		state.Detail = callgraph.DetailUnscoped
	}
	return tr, state
}

func callGraphSamples(answer []k8s.PrometheusQueryResult) []callgraph.Sample {
	out := make([]callgraph.Sample, 0, len(answer))
	for _, row := range answer {
		labels := make(map[string]string, len(row.Metric))
		for k, v := range row.Metric {
			labels[k] = fmt.Sprint(v)
		}
		out = append(out, callgraph.Sample{Labels: labels, Value: row.Value})
	}
	return out
}

// callGraphIndex reads the boxes and lines of the graph answer, a fresh one or one the cache decoded.
func callGraphIndex(namespace string, graph map[string]interface{}) (*callgraph.Index, error) {
	raw, err := json.Marshal(map[string]interface{}{"nodes": graph["nodes"], "edges": graph["edges"]})
	if err != nil {
		return nil, err
	}
	var g struct {
		Nodes []callgraph.Node      `json:"nodes"`
		Edges []callgraph.GraphEdge `json:"edges"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		return nil, err
	}
	return callgraph.NewIndex(namespace, g.Nodes, g.Edges), nil
}
