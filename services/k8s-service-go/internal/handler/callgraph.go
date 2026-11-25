package handler

import (
	"context"
	"encoding/json"
	"errors"
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

// promWindow is the range a metrics read covers: Range back from End, End zero = now (an instant query at now). A
// fixed End is read at that time (the query API's time, the label API's start and end).
type promWindow struct {
	Range time.Duration
	End   time.Time
}

// promAtSource reads at a fixed time (*k8s.Service; a test source without it cannot read a fixed window).
type promAtSource interface {
	PrometheusQueryAt(ctx context.Context, query string, at time.Time) ([]k8s.PrometheusQueryResult, error)
	PrometheusLabelsBetween(ctx context.Context, label, selector string, start, end time.Time, limit int) ([]string, error)
}

var errNoFixedWindow = errors.New("this Prometheus source cannot read a fixed window")

func (w promWindow) query(ctx context.Context, src netdropsSource, query string) ([]k8s.PrometheusQueryResult, error) {
	if w.End.IsZero() {
		return src.PrometheusQuery(ctx, query)
	}
	at, ok := src.(promAtSource)
	if !ok {
		return nil, errNoFixedWindow
	}
	return at.PrometheusQueryAt(ctx, query, w.End)
}

func (w promWindow) labels(ctx context.Context, src netdropsSource, selector string, limit int) ([]string, error) {
	if w.End.IsZero() {
		return src.PrometheusLabels(ctx, "", selector, w.Range, limit)
	}
	at, ok := src.(promAtSource)
	if !ok {
		return nil, errNoFixedWindow
	}
	return at.PrometheusLabelsBetween(ctx, "", selector, w.End.Add(-w.Range), w.End, limit)
}

// callWindowOf reads the calls' window: range (1m–24h back from now, default 1h), or start and end (RFC3339, end
// default now and never past it), the fixed window an alert's investigation or the narrowing reads; the window is 1m to
// 24h either way.
func callWindowOf(rangeParam, start, end string, now time.Time) (promWindow, error) {
	if start == "" && end == "" {
		rng, err := netdrops.ParseRange(rangeParam)
		return promWindow{Range: rng}, err
	}
	if start != "" && rangeParam != "" {
		return promWindow{}, fmt.Errorf("%w: range or start, not both", netdrops.ErrInvalidRequest)
	}
	w := promWindow{End: now}
	if end != "" {
		t, err := time.Parse(time.RFC3339, end)
		if err != nil {
			return promWindow{}, fmt.Errorf("%w: end must be an RFC3339 time", netdrops.ErrInvalidRequest)
		}
		if t.Before(now) {
			w.End = t
		}
	}
	if start == "" {
		rng, err := netdrops.ParseRange(rangeParam)
		if err != nil {
			return promWindow{}, err
		}
		w.Range = rng
		return w, nil
	}
	t, err := time.Parse(time.RFC3339, start)
	if err != nil {
		return promWindow{}, fmt.Errorf("%w: start must be an RFC3339 time", netdrops.ErrInvalidRequest)
	}
	if w.Range = w.End.Sub(t); w.Range < time.Minute || w.Range > 24*time.Hour {
		return promWindow{}, fmt.Errorf("%w: start to end must be between 1m and 24h", netdrops.ErrInvalidRequest)
	}
	return w, nil
}

// resourceGraphCalls is the calls part of a namespace's graph (include=calls) over rangeParam back from now.
func (h *Handler) resourceGraphCalls(r *http.Request, namespace string, graph map[string]interface{}, rangeParam string) (callgraph.Result, error) {
	if !h.cfg.CallGraphEnabled {
		return callgraph.Off(), nil
	}
	rng, err := netdrops.ParseRange(rangeParam)
	if err != nil {
		return callgraph.Result{}, fmt.Errorf("%w: %s", k8s.ErrBadInput, err.Error())
	}
	return h.callsIn(r, namespace, graph, promWindow{Range: rng}, h.netdropsSource(), true)
}

// callsIn is who calls whom over w from the traces' service graph metrics and the Hubble metrics, both in the
// cluster's Prometheus and read through src as the user, placed on the graph's boxes, with the failing workloads
// ordered and the paths between them. Each source that could not be read says why; a source's failure does not fail
// the graph. At most 1 + 3 queries for the traces (1 + 2 without the 90th percentile, which ranks nothing, 1 + 4 with
// features.callGraph.clientLatency) and the traffic lines' reads (5 at most).
func (h *Handler) callsIn(r *http.Request, namespace string, graph map[string]interface{}, w promWindow, src netdropsSource, p90 bool) (callgraph.Result, error) {
	if !h.cfg.CallGraphEnabled {
		return callgraph.Off(), nil
	}
	if !callgraph.ValidNamespace(namespace) {
		return callgraph.Result{}, fmt.Errorf("%w: namespace %q", k8s.ErrBadInput, namespace)
	}
	ctx := r.Context()
	ix, err := callGraphIndex(namespace, graph)
	if err != nil {
		return callgraph.Result{}, err
	}
	res := callgraph.Result{Available: true, Range: w.Range.String(), Sources: []callgraph.SourceState{}}
	if !w.End.IsZero() {
		res.Window = &callgraph.Window{Start: w.End.Add(-w.Range).UTC().Format(time.RFC3339), End: w.End.UTC().Format(time.RFC3339)}
	}

	traces, state := h.callGraphTraces(ctx, r, src, namespace, w, p90)
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
		t, err := h.trafficFromMetrics(ctx, src, []string{namespace}, scope, w)
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
	res.TimeOutsideCallee = callgraph.TimeOutsideCallee(res.Edges)
	if res.Suspects == nil {
		res.Suspects = []callgraph.Suspect{}
	}
	if res.Paths == nil {
		res.Paths = [][]string{}
	}
	return res, nil
}

// callGraphTraces reads the service graph metrics: the label names, then requests, failed requests and (p90) the 90th
// percentile, with features.callGraph.clientLatency the client side's too, which fails nothing when it cannot be read;
// one capped at callgraph.MaxSeries that came back full marks the source truncated. A grant limited to
// namespaces reads none of them, as the Prometheus screens refuse it: a metric without namespace labels names every
// namespace's services.
func (h *Handler) callGraphTraces(ctx context.Context, r *http.Request, src netdropsSource, namespace string, w promWindow, p90 bool) (*callgraph.Traces, callgraph.SourceState) {
	state := callgraph.SourceState{Source: callgraph.SourceTraces}
	if len(promScope(r)) > 0 {
		state.Reason = callgraph.ReasonNamespaceLimited
		return nil, state
	}
	if !src.PrometheusAvailable(ctx) {
		state.Reason = callgraph.ReasonNoPrometheus
		return nil, state
	}
	labels, err := w.labels(ctx, src, callgraph.RequestsMetric, 200)
	if err != nil {
		state.Reason, state.Detail = callgraph.ReasonFailed, err.Error()
		return nil, state
	}
	shape, ok := callgraph.DetectShape(labels, callGraphNamespaceAttribute)
	if !ok {
		state.Reason = callgraph.ReasonNoMetrics
		return nil, state
	}
	q := callgraph.BuildQueries(shape, namespace, w.Range)
	tr := &callgraph.Traces{Shape: shape}
	reads := []struct {
		query string
		into  *[]callgraph.Sample
	}{{q.Requests, &tr.Requests}, {q.Failed, &tr.Failed}}
	if p90 {
		reads = append(reads, struct {
			query string
			into  *[]callgraph.Sample
		}{q.P90, &tr.P90})
	}
	for _, read := range reads {
		answer, err := w.query(ctx, src, read.query)
		if err != nil {
			state.Reason, state.Detail = callgraph.ReasonFailed, err.Error()
			return nil, state
		}
		*read.into = callGraphSamples(answer)
	}
	state.Read, state.Series, state.Truncated = true, len(tr.Requests), tr.Cut()
	if shape.Namespace == "" {
		state.Detail = callgraph.DetailUnscoped
	}
	if p90 && h.cfg.CallGraphClientLatency {
		state.ClientP90 = callGraphClientP90(ctx, src, w, q.ClientP90, tr)
	}
	return tr, state
}

// callGraphClientP90 reads the client side's 90th percentile into tr, one query, not asked when the traces count no
// call. An empty answer for calls they do count is a Prometheus without that metric.
func callGraphClientP90(ctx context.Context, src netdropsSource, w promWindow, query string, tr *callgraph.Traces) *callgraph.ClientP90 {
	if len(tr.Requests) == 0 {
		return &callgraph.ClientP90{Reason: callgraph.ReasonNoCalls}
	}
	answer, err := w.query(ctx, src, query)
	switch {
	case err != nil:
		return &callgraph.ClientP90{Reason: callgraph.ReasonFailed, Detail: err.Error()}
	case len(answer) == 0:
		return &callgraph.ClientP90{Reason: callgraph.ReasonNoMetrics, Detail: callgraph.DetailNoClientSeconds}
	}
	tr.ClientP90 = callGraphSamples(answer)
	return &callgraph.ClientP90{Read: true, Series: len(answer), Truncated: tr.ClientCut()}
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
