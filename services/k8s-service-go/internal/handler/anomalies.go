package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/anomaly"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// anomalySource is what a narrowing read needs, all as the signed-in user (*k8s.Service; tests replace it).
type anomalySource interface {
	CollectIssues(ctx context.Context, opts k8s.IssuesOptions) ([]k8s.Issue, error)
	GetPods(ctx context.Context, namespace string, labelSelector string) ([]map[string]interface{}, error)
	PrometheusAvailable(ctx context.Context) bool
	PrometheusQueryAt(ctx context.Context, query string, at time.Time) ([]k8s.PrometheusQueryResult, error)
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
// A read of lists and metrics like the issues and the drawers' graphs, so it is not audited. The same caller asking the
// same window within features.anomalyRank.cacheSeconds gets the answer it got.
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
	if res, ok := h.anomalyAnswers.get(key, now, ttl); ok && claims != "" {
		accesstrail.Cached(ctx, "the same narrowing a moment ago")
		response.JSON(w, http.StatusOK, res)
		return
	}
	res := h.rankAnomalies(ctx, namespace, wl, win, len(payload.Namespaces[string(id)]) > 0)
	if claims != "" {
		h.anomalyAnswers.put(key, now, ttl, res)
	}
	response.JSON(w, http.StatusOK, res)
}

// rankAnomalies runs the checks: the pods and the issue check once, then the metric checks, at most
// features.anomalyRank.concurrency at once, each within checkTimeoutSeconds and all within timeoutSeconds.
func (h *Handler) rankAnomalies(ctx context.Context, namespace string, wl *anomaly.Workload, win anomaly.Window, namespaceLimited bool) anomaly.Result {
	src := h.anomalySource()
	ctx, cancel := context.WithTimeout(ctx, secondsOr(h.cfg.AnomalyRankTimeoutSec, 20))
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
	add := func(r anomaly.CheckResult) {
		mu.Lock()
		results = append(results, r)
		mu.Unlock()
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
			wg.Add(1)
			go func(q anomaly.Query) {
				defer wg.Done()
				run(func(c context.Context) { add(metricCheck(c, src, budget, q, win)) })
			}(q)
		}
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
	return anomaly.Assemble(namespace, wl, win, results, budget.used())
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
func metricCheck(ctx context.Context, src anomalySource, budget *anomalyBudget, q anomaly.Query, win anomaly.Window) anomaly.CheckResult {
	if !budget.take(2) {
		return anomaly.CheckResult{Check: q.Check, NotRun: "this answer's store queries are spent (features.anomalyRank.maxQueries)"}
	}
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
}

// anomalyAnswers keeps each answer for a while, keyed by cluster, claims, namespace, window and workload.
type anomalyAnswers struct {
	mu      sync.Mutex
	entries map[string]anomalyEntry
}

func (c *anomalyAnswers) get(key string, now time.Time, ttl time.Duration) (anomaly.Result, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || now.Sub(e.at) >= ttl {
		return anomaly.Result{}, false
	}
	return e.result, true
}

func (c *anomalyAnswers) put(key string, now time.Time, ttl time.Duration, r anomaly.Result) {
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
	c.entries[key] = anomalyEntry{at: now, result: r}
}
