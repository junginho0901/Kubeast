package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/anomaly"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/traces"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// anomalySource is what a narrowing read needs, all as the signed-in user (*k8s.Service; tests replace it).
type anomalySource interface {
	CollectIssues(ctx context.Context, opts k8s.IssuesOptions) ([]k8s.Issue, error)
	GetPods(ctx context.Context, namespace string, labelSelector string) ([]map[string]interface{}, error)
	PrometheusAvailable(ctx context.Context) bool
	PrometheusQueryAt(ctx context.Context, query string, at time.Time) ([]k8s.PrometheusQueryResult, error)
	ProtectedNamespaces(ctx context.Context) protectedns.Namespaces
}

func (h *Handler) anomalySource() anomalySource {
	if h.anomalySrc != nil {
		return h.anomalySrc
	}
	return h.svc
}

func (h *Handler) anomalyClock() time.Time {
	if h.anomalyNow != nil {
		return h.anomalyNow()
	}
	return time.Now()
}

func secondsOr(n, fallback int) time.Duration {
	if n <= 0 {
		n = fallback
	}
	return time.Duration(n) * time.Second
}

func countOr(n, fallback int) int {
	if n <= 0 {
		return fallback
	}
	return n
}

// GetNamespaceAnomalies handles GET /api/v1/namespaces/{namespace}/anomalies?start=&end=&workload_kind=&workload_name=:
// what differs in the namespace between the window and the window of the same length before it, ranked (internal/anomaly).
// Its lists and metrics are read like the issues and the drawers' graphs, not audited; its log and trace reads pass the
// log tools' door and leave the rows those tools leave (k8s.pod.logs.logql, k8s.traces.query). The same caller asking
// the same window within features.anomalyRank.cacheSeconds gets the answer it got, its store rows written again.
func (h *Handler) GetNamespaceAnomalies(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.AnomalyRankEnabled {
		response.Error(w, http.StatusNotFound, "anomaly ranking is off (features.anomalyRank.enabled)")
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	q := r.URL.Query()
	now := h.anomalyClock()
	err := anomaly.ParseNamespace(namespace)
	var win anomaly.Window
	if err == nil {
		win, err = anomaly.ParseWindow(q.Get("start"), q.Get("end"), now)
	}
	var wl *anomaly.Workload
	if err == nil {
		wl, err = anomaly.ParseWorkload(q.Get("workload_kind"), q.Get("workload_name"))
	}
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	id, _ := cluster.FromContext(ctx)
	payload, _ := auth.FromContext(ctx)
	// a token whose claims cannot be keyed shares nothing
	claims := payload.ClaimsKey()
	key := strings.Join([]string{string(id), claims, namespace, win.Start.UTC().Format(time.RFC3339), win.End.UTC().Format(time.RFC3339),
		q.Get("workload_kind"), q.Get("workload_name")}, "|")
	ttl := secondsOr(h.cfg.AnomalyRankCacheSec, 60)
	if e, ok := h.anomalyAnswers.get(key, now, ttl); ok && claims != "" && h.recordStoreReads(r, namespace, e.rows, true) == nil {
		accesstrail.Cached(ctx, "the same narrowing a moment ago")
		response.JSON(w, http.StatusOK, e.result)
		return
	}
	res, rows, recorded := h.rankAnomalies(r, namespace, wl, win, len(payload.Namespaces[string(id)]) > 0)
	if claims != "" && recorded {
		h.anomalyAnswers.put(key, now, ttl, anomalyEntry{result: res, rows: rows})
	}
	response.JSON(w, http.StatusOK, res)
}

// rankAnomalies runs the checks: the pods and the issue check once, then the metric, log and trace checks, at most
// features.anomalyRank.concurrency at once, each within checkTimeoutSeconds and all within timeoutSeconds. The store
// queries are taken from the answer's budget in check order before any runs, so the same budget gives the same checks.
// It returns the store rows it wrote and whether they were all written (a check whose row could not be written is not
// run, and the answer is not kept).
func (h *Handler) rankAnomalies(r *http.Request, namespace string, wl *anomaly.Workload, win anomaly.Window, namespaceLimited bool) (anomaly.Result, []storeRow, bool) {
	src := h.anomalySource()
	ctx, cancel := context.WithTimeout(r.Context(), secondsOr(h.cfg.AnomalyRankTimeoutSec, 20))
	defer cancel()
	perCheck := secondsOr(h.cfg.AnomalyRankCheckTimeoutSec, 5)
	places := make(chan struct{}, countOr(h.cfg.AnomalyRankConcurrency, 4))
	run := func(fn func(context.Context)) {
		select {
		case places <- struct{}{}:
		case <-ctx.Done():
			fn(ctx)
			return
		}
		defer func() { <-places }()
		checkCtx, cancelCheck := context.WithTimeout(ctx, perCheck)
		defer cancelCheck()
		fn(checkCtx)
	}

	var (
		wg        sync.WaitGroup
		mu        sync.Mutex
		results   []anomaly.CheckResult
		issues    []k8s.Issue
		issuesErr error
		pods      []map[string]interface{}
		podsErr   error
	)
	add := func(rs ...anomaly.CheckResult) {
		mu.Lock()
		results = append(results, rs...)
		mu.Unlock()
	}
	notRun := func(checks []string, why string) {
		for _, c := range checks {
			add(anomaly.CheckResult{Check: c, NotRun: why})
		}
	}
	wg.Add(2)
	go func() {
		defer wg.Done()
		run(func(c context.Context) {
			issues, issuesErr = src.CollectIssues(c, k8s.IssuesOptions{Window: win.Length(), Now: win.End, Namespace: namespace})
		})
	}()
	go func() {
		defer wg.Done()
		run(func(c context.Context) { pods, podsErr = src.GetPods(c, namespace, "") })
	}()

	queries := anomaly.Queries(namespace, wl, win.Length())
	budget := &anomalyBudget{left: countOr(h.cfg.AnomalyRankMaxQueries, 12)}
	switch {
	case namespaceLimited:
		// as the Prometheus routes refuse such a grant (prometheus_scope.go): the cluster's Prometheus answers for every namespace
		for _, q := range queries {
			add(anomaly.CheckResult{Check: q.Check, NotRun: "the cluster's Prometheus covers the whole cluster; your grant on this cluster is limited to namespaces"})
		}
	case !src.PrometheusAvailable(ctx):
		for _, q := range queries {
			add(anomaly.CheckResult{Check: q.Check, NotRun: "no Prometheus reaches this cluster"})
		}
	default:
		for _, q := range queries {
			if !budget.take(2) {
				add(anomaly.CheckResult{Check: q.Check, NotRun: budgetSpent})
				continue
			}
			wg.Add(1)
			go func(q anomaly.Query) {
				defer wg.Done()
				run(func(c context.Context) { add(metricCheck(c, src, q, win)) })
			}(q)
		}
	}

	podLogs := h.podLogsOnce(ctx, namespace)
	logs := &storeReads{action: "k8s.pod.logs.logql", checks: anomaly.LogChecks, rangeSeconds: int64(2 * win.Length() / time.Second)}
	switch why := h.logChecksRefusal(r, src, namespace, win, podLogs); {
	case why != "":
		notRun(anomaly.LogChecks, why)
	case !budget.take(3):
		notRun(anomaly.LogChecks, budgetSpent)
	default:
		logs.ran = true
		wg.Add(1)
		go func() {
			defer wg.Done()
			add(h.logChecks(r, run, budget, logs, namespace, wl, win)...)
		}()
	}
	traceReads := &storeReads{action: "k8s.traces.query", checks: anomaly.TraceChecks, rangeSeconds: int64(2 * win.Length() / time.Second)}
	step, stepOK := anomaly.TraceStep(win)
	switch why := h.traceChecksRefusal(r, namespace, win, podLogs); {
	case why != "":
		notRun(anomaly.TraceChecks, why)
	case !stepOK:
		notRun(anomaly.TraceChecks, "the window's bounds are not on whole minutes, which the trace checks need to cut both windows into the same steps")
	case !budget.take(3):
		notRun(anomaly.TraceChecks, budgetSpent)
	default:
		traceReads.ran = true
		wg.Add(1)
		go func() {
			defer wg.Done()
			add(h.traceChecks(r, run, traceReads, namespace, wl, win, step)...)
		}()
	}
	wg.Wait()

	switch {
	case issuesErr != nil:
		add(anomaly.CheckResult{Check: anomaly.CheckIssues, NotRun: readFailure("the issue check", issuesErr)})
		add(anomaly.CheckResult{Check: anomaly.CheckNodePressure, NotRun: readFailure("the issue check", issuesErr)})
	case podsErr != nil:
		add(anomaly.CheckResult{Check: anomaly.CheckIssues, NotRun: readFailure("the pods", podsErr)})
		add(anomaly.CheckResult{Check: anomaly.CheckNodePressure, NotRun: readFailure("the pods", podsErr)})
	default:
		rows, nodesErr := issueRows(issues)
		add(anomaly.FromIssues(rows, pods, wl))
		add(anomaly.FromNodePressure(rows, pods, wl, nodesErr))
	}
	if podsErr != nil {
		add(anomaly.CheckResult{Check: anomaly.CheckCrashReasons, NotRun: readFailure("the pods", podsErr)})
	} else {
		add(anomaly.FromCrashReasons(pods, wl, win))
	}

	var rows []storeRow
	recorded := true
	for _, reads := range []*storeReads{logs, traceReads} {
		if !reads.ran {
			continue
		}
		row := reads.row()
		if err := h.recordStoreReads(r, namespace, []storeRow{row}, false); err != nil {
			slog.WarnContext(r.Context(), "audit: leaving out the narrowing's store reads", "action", reads.action, "error", err)
			results = withNotRun(results, reads.checks, "the audit log could not take this read's row, so its answer is left out")
			recorded = false
			continue
		}
		rows = append(rows, row)
	}
	return anomaly.Assemble(namespace, wl, win, results, budget.used()), rows, recorded
}

const budgetSpent = "this answer's store queries are spent (features.anomalyRank.maxQueries)"

// withNotRun replaces the results of checks by not run, why.
func withNotRun(results []anomaly.CheckResult, checks []string, why string) []anomaly.CheckResult {
	drop := map[string]bool{}
	for _, c := range checks {
		drop[c] = true
	}
	out := results[:0]
	for _, r := range results {
		if !drop[r.Check] {
			out = append(out, r)
		}
	}
	for _, c := range checks {
		out = append(out, anomaly.CheckResult{Check: c, NotRun: why})
	}
	return out
}

// podLogsOnce asks the cluster once, as the caller, whether they may read pod logs in namespace (get pods/log): the
// log tools' and the trace tools' door both ask it. It says why not, "" when they may.
func (h *Handler) podLogsOnce(ctx context.Context, namespace string) func() string {
	var once sync.Once
	var why string
	return func() string {
		once.Do(func() {
			allowed, err := h.canReadPodLogs(ctx, namespace)
			switch {
			case err != nil:
				why = readFailure("the pods/log access review", err)
			case !allowed:
				why = "the cluster does not let you read pod logs in " + namespace
			}
		})
		return why
	}
}

// logChecksRefusal says why the log checks do not run for this caller, by the log tools' door (openReadDoor): log
// search for the cluster, resource.pod.read, the node shell namespace's rule for a log read (protectedns ActLog: the
// route itself is a read), both windows within features.logSearch.maxRange, get pods/log, the per-user rate (one
// search for the answer) and an audit store that takes rows. The namespace is always named, so no matcher leaves a namespace out (hiddenLogNamespace). "" = they run.
func (h *Handler) logChecksRefusal(r *http.Request, src anomalySource, namespace string, win anomaly.Window, podLogs func() string) string {
	ctx := r.Context()
	id, _ := cluster.FromContext(ctx)
	payload, _ := auth.FromContext(ctx)
	switch {
	case h.logSearch == nil || !h.logSearch.Configured(ctx, string(id)):
		return "no log store for this cluster (features.logSearch, or the cluster's own store)"
	case !payload.HasPermissionForCluster("resource.pod.read", string(id)):
		return "reading logs needs resource.pod.read on this cluster"
	}
	if err := src.ProtectedNamespaces(ctx).Refusal(payload, string(id), namespace, protectedns.ActLog); err != nil {
		return err.Error()
	}
	if both := 2 * win.Length(); both > h.logSearch.Config().MaxRange {
		return fmt.Sprintf("the window and the one before (%s) are longer than log search reads at once (features.logSearch.maxRange %s)", both, h.logSearch.Config().MaxRange)
	}
	if why := podLogs(); why != "" {
		return why
	}
	if !h.logSearch.Allow(payload.UserID) {
		return fmt.Sprintf("too many log searches: %d per minute", h.logSearch.Config().PerUserPerMinute)
	}
	if err := h.auditReady(r); err != nil {
		return "the audit log cannot take a row now, and log reads are audited"
	}
	return ""
}

// traceChecksRefusal is logChecksRefusal for the trace checks, by the trace tools' door: the trace store for the
// cluster, resource.pod.read, both windows within features.traceStore.maxRange, get pods/log (who may read a pod's
// logs may read its traces), the per-user rate and an audit store that takes rows. The trace routes are reads in the node shell namespace, and so are these checks.
func (h *Handler) traceChecksRefusal(r *http.Request, namespace string, win anomaly.Window, podLogs func() string) string {
	ctx := r.Context()
	id, _ := cluster.FromContext(ctx)
	payload, _ := auth.FromContext(ctx)
	switch {
	case h.traceStore == nil || !h.traceStore.Configured(ctx, string(id)):
		return "no trace store for this cluster (features.traceStore)"
	case !payload.HasPermissionForCluster("resource.pod.read", string(id)):
		return "reading traces needs resource.pod.read on this cluster"
	}
	if both := 2 * win.Length(); both > h.traceStore.Config().MaxRange {
		return fmt.Sprintf("the window and the one before (%s) are longer than the trace store reads at once (features.traceStore.maxRange %s)", both, h.traceStore.Config().MaxRange)
	}
	if why := podLogs(); why != "" {
		return why
	}
	if !h.traceStore.Allow(payload.UserID) {
		return fmt.Sprintf("too many trace reads: %d per minute", h.traceStore.Config().PerUserPerMinute)
	}
	if err := h.auditReady(r); err != nil {
		return "the audit log cannot take a row now, and trace reads are audited"
	}
	return ""
}

// logChecks estimates the namespace's log volume over both windows from the store's index, then, under
// features.anomalyRank.logMaxBytes and with lines there, reads the error shapes and counts. Three store queries were
// taken; those not made go back.
func (h *Handler) logChecks(r *http.Request, run func(func(context.Context)), budget *anomalyBudget, reads *storeReads, namespace string, wl *anomaly.Workload, win anomaly.Window) []anomaly.CheckResult {
	id, _ := cluster.FromContext(r.Context())
	cfg := h.logSearch.Config()
	labels := anomaly.LogLabels{Pod: cfg.Labels.Pod, Container: cfg.Labels.Container}
	selector := anomaly.LogSelector(labels, wl)
	before := win.Before()
	both := func(why string) []anomaly.CheckResult {
		budget.give(2)
		return []anomaly.CheckResult{{Check: anomaly.CheckErrorLogShapes, NotRun: why}, {Check: anomaly.CheckErrorLogCounts, NotRun: why}}
	}

	var vol logsearch.Volume
	var err error
	run(func(c context.Context) {
		var eff string
		vol, eff, err = h.logSearch.Estimate(c, logsearch.QueryRequest{Cluster: string(id), Namespace: namespace, Query: selector, Start: before.Start, End: win.End})
		reads.sent(eff, err)
	})
	reads.count("estimated_bytes", vol.Bytes)
	limit := h.cfg.AnomalyRankLogMaxBytes
	if limit <= 0 {
		limit = 10 << 30
	}
	switch {
	case errors.Is(err, logsearch.ErrNotServed):
		return both("the log store does not serve its index stats (Loki's /loki/api/v1/index/stats), which the log checks read first")
	case err != nil:
		return both(readFailure("the log store's index", err))
	case vol.Bytes > limit:
		return both(fmt.Sprintf("too large: the log store's index puts these logs over the window and the one before at %s, past features.anomalyRank.logMaxBytes (%s); narrow with workload_kind and workload_name or a shorter window",
			logsearch.Size(vol.Bytes), logsearch.Size(limit)))
	case vol.Entries == 0:
		return both("the log store holds no lines for this namespace (or workload) in the window or the one before")
	}

	var (
		wg               sync.WaitGroup
		shapes, counts   anomaly.CheckResult
		patterns, series int
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		run(func(c context.Context) {
			ps, eff, perr := h.logSearch.PatternSamples(c, logsearch.QueryRequest{Cluster: string(id), Namespace: namespace, Query: selector, Start: before.Start, End: win.End})
			reads.sent(eff, perr)
			switch {
			case errors.Is(perr, logsearch.ErrNotServed):
				shapes = anomaly.CheckResult{Check: anomaly.CheckErrorLogShapes, NotRun: "the log store does not serve log shapes (Loki needs pattern_ingester.enabled)"}
			case perr != nil:
				shapes = anomaly.CheckResult{Check: anomaly.CheckErrorLogShapes, NotRun: readFailure("the log store", perr)}
			default:
				patterns = len(ps)
				samples := make([]anomaly.PatternSample, 0, len(ps))
				for _, p := range ps {
					samples = append(samples, anomaly.PatternSample{Pattern: p.Pattern, Level: p.Level, Samples: p.Samples})
				}
				shapes = anomaly.FromPatterns(samples, win)
			}
		})
	}()
	go func() {
		defer wg.Done()
		run(func(c context.Context) {
			res, qerr := h.logSearch.Query(c, logsearch.QueryRequest{Cluster: string(id), Namespace: namespace, Query: anomaly.ErrorCountQuery(labels, wl, win.Length()),
				Start: win.Start, End: win.End, Limit: cfg.MaxLines, Metric: true, Step: win.Length()})
			reads.sent(res.EffectiveQuery, qerr)
			if qerr != nil {
				counts = anomaly.CheckResult{Check: anomaly.CheckErrorLogCounts, NotRun: readFailure("the log store", qerr)}
				return
			}
			series = len(res.Series)
			now, prev := map[string]float64{}, map[string]float64{}
			for _, s := range res.Series {
				for _, p := range s.Points {
					switch int64(p.T) {
					case win.End.Unix():
						now[s.Metric[labels.Container]] += p.V
					case win.Start.Unix():
						prev[s.Metric[labels.Container]] += p.V
					}
				}
			}
			counts = anomaly.FromLogCounts(now, prev)
		})
	}()
	wg.Wait()
	reads.count("patterns", patterns)
	reads.count("series", series)
	return []anomaly.CheckResult{shapes, counts}
}

// traceChecks reads each service's server spans, failed server spans and p90 over both windows at step.
func (h *Handler) traceChecks(r *http.Request, run func(func(context.Context)), reads *storeReads, namespace string, wl *anomaly.Workload, win anomaly.Window, step time.Duration) []anomaly.CheckResult {
	id, _ := cluster.FromContext(r.Context())
	before := win.Before()
	var (
		wg     sync.WaitGroup
		mu     sync.Mutex
		got    = map[string][]anomaly.TraceSeries{}
		failed = map[string]string{}
		series int
	)
	for _, q := range anomaly.TraceQueries(wl) {
		wg.Add(1)
		go func(q anomaly.TraceQuery) {
			defer wg.Done()
			run(func(c context.Context) {
				res, err := h.traceStore.Metrics(c, traces.Scope{Cluster: string(id), Namespace: namespace}, q.Query, before.Start, win.End, step)
				reads.sent(res.EffectiveQuery, err)
				mu.Lock()
				defer mu.Unlock()
				switch {
				case errors.Is(err, traces.ErrNotServed):
					failed[q.Signal] = "the trace store does not serve TraceQL metrics (Tempo's metrics-generator with the local-blocks processor)"
				case err != nil:
					failed[q.Signal] = readFailure("the trace store", err)
				default:
					series += len(res.Series)
					for _, s := range res.Series {
						ts := anomaly.TraceSeries{Service: s.Metric["resource.service.name"]}
						for _, p := range s.Points {
							ts.Points = append(ts.Points, [2]float64{p.T, p.V})
						}
						got[q.Signal] = append(got[q.Signal], ts)
					}
				}
			})
		}(q)
	}
	wg.Wait()
	reads.count("series", series)
	out := make([]anomaly.CheckResult, 0, 3)
	if why := failed[anomaly.SignalRequests]; why != "" {
		out = append(out, anomaly.CheckResult{Check: anomaly.CheckTraceRequests, NotRun: why}, anomaly.CheckResult{Check: anomaly.CheckTraceErrors, NotRun: why})
	} else {
		out = append(out, anomaly.FromTraceRequests(got[anomaly.SignalRequests], win))
		if why := failed[anomaly.SignalErrors]; why != "" {
			out = append(out, anomaly.CheckResult{Check: anomaly.CheckTraceErrors, NotRun: why})
		} else {
			out = append(out, anomaly.FromTraceErrors(got[anomaly.SignalRequests], got[anomaly.SignalErrors], win))
		}
	}
	if why := failed[anomaly.SignalLatency]; why != "" {
		out = append(out, anomaly.CheckResult{Check: anomaly.CheckTraceLatency, NotRun: why})
	} else {
		out = append(out, anomaly.FromTraceLatency(got[anomaly.SignalLatency], win))
	}
	return out
}

// storeReads is what one answer read of a store, for its audit row: the queries as sent, the range, how much came back
// and the first failure — never lines, shapes or spans.
type storeReads struct {
	action       string
	checks       []string
	ran          bool
	rangeSeconds int64
	mu           sync.Mutex
	queries      []string
	counts       map[string]interface{}
	err          error
}

func (s *storeReads) sent(query string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if query != "" {
		s.queries = append(s.queries, query)
	}
	if err != nil && s.err == nil {
		s.err = err
	}
}

func (s *storeReads) count(key string, v interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.counts == nil {
		s.counts = map[string]interface{}{}
	}
	s.counts[key] = v
}

func (s *storeReads) row() storeRow {
	s.mu.Lock()
	defer s.mu.Unlock()
	after := map[string]interface{}{"kind": "anomaly", "effective": s.queries, "range_seconds": s.rangeSeconds}
	for k, v := range s.counts {
		after[k] = v
	}
	b, _ := json.Marshal(after)
	return storeRow{action: s.action, after: b, err: s.err}
}

// storeRow is one audit row of the narrowing's store reads.
type storeRow struct {
	action string
	after  json.RawMessage
	err    error
}

// recordStoreReads writes the rows, as the log and trace tools write theirs; cached marks an answer given again.
func (h *Handler) recordStoreReads(r *http.Request, namespace string, rows []storeRow, cached bool) error {
	for _, row := range rows {
		after := row.after
		if cached {
			var m map[string]interface{}
			_ = json.Unmarshal(after, &m)
			m["cached"] = true
			after, _ = json.Marshal(m)
		}
		if err := h.recordAuditWithPayload(r, row.action, "namespace", namespace, namespace, row.err, nil, after); err != nil {
			return err
		}
	}
	return nil
}

// issueRows are the issue check's rows for internal/anomaly, with the nodes' list failure apart.
func issueRows(issues []k8s.Issue) ([]anomaly.IssueRow, string) {
	rows := make([]anomaly.IssueRow, 0, len(issues))
	nodesErr := ""
	for _, is := range issues {
		if is.Kind == "Collector" && is.Name == "nodes" {
			nodesErr = is.Message
			continue
		}
		rows = append(rows, anomaly.IssueRow{Kind: is.Kind, Name: is.Name, Severity: is.Severity, Reason: is.Reason, Message: is.Message})
	}
	return rows, nodesErr
}

// metricCheck runs one metric check's query at the end of the window and at the end of the window before it.
func metricCheck(ctx context.Context, src anomalySource, q anomaly.Query, win anomaly.Window) anomaly.CheckResult {
	now, err := src.PrometheusQueryAt(ctx, q.Expr, win.End)
	var before []k8s.PrometheusQueryResult
	if err == nil {
		before, err = src.PrometheusQueryAt(ctx, q.Expr, win.Start)
	}
	if err != nil {
		return anomaly.CheckResult{Check: q.Check, NotRun: readFailure("Prometheus", err)}
	}
	return anomaly.FromMetric(q.Check, samplesOf(now), samplesOf(before))
}

func samplesOf(rows []k8s.PrometheusQueryResult) []anomaly.Sample {
	out := make([]anomaly.Sample, 0, len(rows))
	for _, row := range rows {
		labels := make(map[string]string, len(row.Metric))
		for k, v := range row.Metric {
			labels[k] = fmt.Sprint(v)
		}
		out = append(out, anomaly.Sample{Labels: labels, Value: row.Value})
	}
	return out
}

// readFailure says why a read gave nothing, without the server's address.
func readFailure(what string, err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return what + " did not answer in time"
	}
	return what + ": " + response.Public(err)
}

// anomalyBudget counts one answer's store queries.
type anomalyBudget struct {
	mu    sync.Mutex
	left  int
	spent int
}

func (b *anomalyBudget) take(n int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.left < n {
		return false
	}
	b.left -= n
	b.spent += n
	return true
}

// give returns n queries taken and not made.
func (b *anomalyBudget) give(n int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.left += n
	b.spent -= n
}

func (b *anomalyBudget) used() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.spent
}

// anomalyAnswersMax bounds the answers kept: past it the oldest goes.
const anomalyAnswersMax = 256

type anomalyEntry struct {
	at     time.Time
	result anomaly.Result
	// rows are the store reads' audit rows, written again when the answer is given again
	rows []storeRow
}

// anomalyAnswers keeps each answer for a while, keyed by cluster, claims, namespace, window and workload.
type anomalyAnswers struct {
	mu      sync.Mutex
	entries map[string]anomalyEntry
}

func (c *anomalyAnswers) get(key string, now time.Time, ttl time.Duration) (anomalyEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || now.Sub(e.at) >= ttl {
		return anomalyEntry{}, false
	}
	return e, true
}

func (c *anomalyAnswers) put(key string, now time.Time, ttl time.Duration, entry anomalyEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]anomalyEntry{}
	}
	oldest, oldestAt := "", now
	for k, e := range c.entries {
		if now.Sub(e.at) >= ttl {
			delete(c.entries, k)
			continue
		}
		if e.at.Before(oldestAt) {
			oldest, oldestAt = k, e.at
		}
	}
	if len(c.entries) >= anomalyAnswersMax && oldest != "" {
		delete(c.entries, oldest)
	}
	entry.at = now
	c.entries[key] = entry
}
