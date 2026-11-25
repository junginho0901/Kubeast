package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nodecpu"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Limits of one node neighbours answer, with nodecpu.MaxQueries reads in all.
const (
	nodeNeighborsTimeout     = 20 * time.Second
	nodeNeighborsReadTimeout = 5 * time.Second
	nodeNeighborsCache       = time.Minute
	// nodeNeighborsReviews bounds the namespaces asked about one by one when the node's pods could not be listed.
	nodeNeighborsReviews = 10
)

// nodeCPUSource is what a node neighbours read needs, all as the signed-in user (*k8s.Service; tests replace it).
type nodeCPUSource interface {
	DescribeNodeWithoutEvents(ctx context.Context, name string) (map[string]interface{}, error)
	GetNodePods(ctx context.Context, nodeName string) ([]map[string]interface{}, error)
	GetPodMetrics(ctx context.Context, namespace string) ([]map[string]interface{}, error)
	GetNodeMetrics(ctx context.Context) ([]map[string]interface{}, error)
	PrometheusAvailable(ctx context.Context) bool
	PrometheusQueryRange(ctx context.Context, query string, start, end time.Time, stepSeconds int) ([]k8s.PrometheusRangeSeries, error)
}

// NodeNeighborsOn is features.nodeNeighbors.enabled (NODE_NEIGHBORS_ENABLED), off by default.
func NodeNeighborsOn() bool { return pkgconfig.EnvSwitch("NODE_NEIGHBORS_ENABLED") }

// NodeNeighbors serves GET /api/v1/nodes/{name}/neighbors.
type NodeNeighbors struct {
	h   *Handler
	on  bool
	src nodeCPUSource
	// mayListPods asks the cluster, as the caller, whether they may list the pods of a namespace.
	mayListPods func(ctx context.Context, namespace string) (bool, error)
	now         func() time.Time
	answers     nodeAnswers
}

// NodeNeighbors is the node neighbours route of this server, its switch read once.
func (h *Handler) NodeNeighbors() *NodeNeighbors {
	return &NodeNeighbors{h: h, on: NodeNeighborsOn(), src: h.svc, mayListPods: h.mayListPods, now: time.Now}
}

func (h *Handler) mayListPods(ctx context.Context, namespace string) (bool, error) {
	reviews, err := h.svc.ReviewsFor(ctx)
	if err != nil {
		return false, err
	}
	review, err := reviews.Create(ctx, &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{Verb: "list", Resource: "pods", Namespace: namespace}},
	}, metav1.CreateOptions{})
	if err != nil {
		return false, err
	}
	return review.Status.Allowed, nil
}

// Get handles GET /api/v1/nodes/{name}/neighbors?start=&end=: what used the node's CPU between the window and the window
// of the same length before it (internal/nodecpu). The node and its pods are read as the caller; the metrics are read like
// the drawers' graphs, which leave no audit row (the row of an AI call is ai-service's). What the caller may not list is
// counted, not named. The same caller asking the same window of the same node within a minute gets the answer they got.
func (n *NodeNeighbors) Get(w http.ResponseWriter, r *http.Request) {
	if !n.on {
		response.Error(w, http.StatusNotFound, "node neighbors is off (features.nodeNeighbors.enabled)")
		return
	}
	ctx := r.Context()
	node := chi.URLParam(r, "name")
	q := r.URL.Query()
	now := n.now()
	err := nodecpu.ParseNode(node)
	var win nodecpu.Window
	if err == nil {
		win, err = nodecpu.ParseWindow(q.Get("start"), q.Get("end"), now)
	}
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	id, _ := cluster.FromContext(ctx)
	payload, _ := auth.FromContext(ctx)
	// a token whose claims cannot be keyed shares nothing
	claims := payload.ClaimsKey()
	key := strings.Join([]string{string(id), claims, node, win.Start.UTC().Format(time.RFC3339), win.End.UTC().Format(time.RFC3339)}, "|")
	if res, ok := n.answers.get(key, now); ok && claims != "" {
		accesstrail.Cached(ctx, "the same node's neighbours a moment ago")
		response.JSON(w, http.StatusOK, res)
		return
	}
	res, whole, err := n.read(ctx, node, win, payload.Namespaces[string(id)])
	if err != nil {
		n.h.handleError(w, err)
		return
	}
	// an answer with a read that failed is not kept: the next one asks again
	if claims != "" && whole {
		n.answers.put(key, now, res)
	}
	response.JSON(w, http.StatusOK, res)
}

// read reads the node, its pods and their metrics. Only the node itself is needed: what else could not be read is said in
// the answer, which is whole when none of its reads failed.
func (n *NodeNeighbors) read(ctx context.Context, node string, win nodecpu.Window, scope []string) (res nodecpu.Result, whole bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, nodeNeighborsTimeout)
	defer cancel()
	var (
		wg              sync.WaitGroup
		desc            map[string]interface{}
		pods            []map[string]interface{}
		nodeErr, podErr error
	)
	// both list the node's pods, which is one shared read while the cluster's informers run (podsOnNodeOf)
	wg.Add(2)
	go func() {
		defer wg.Done()
		desc, nodeErr = n.src.DescribeNodeWithoutEvents(ctx, node)
	}()
	go func() {
		defer wg.Done()
		pods, podErr = n.src.GetNodePods(ctx, node)
	}()
	wg.Wait()
	if nodeErr != nil {
		return nodecpu.Result{}, false, nodeErr
	}
	in := nodecpu.Input{Node: node, Window: win, Pods: nodecpu.PodsFromRows(pods)}
	if podErr != nil {
		in.PodsError = readFailure("the pods on the node", podErr)
	}
	addresses := fillNodeInput(&in, desc)

	budget := &readBudget{left: nodecpu.MaxQueries, failed: podErr != nil}
	switch {
	case len(scope) > 0:
		// as the Prometheus routes refuse such a grant (prometheus_scope.go): the cluster's Prometheus answers for every namespace
		in.NotRun = append(in.NotRun, nodecpu.NotRun{What: nodecpu.WhatPrometheus, Reason: "the cluster's Prometheus covers the whole cluster; your grant on this cluster is limited to namespaces"})
	case !n.src.PrometheusAvailable(ctx):
		in.NotRun = append(in.NotRun, nodecpu.NotRun{What: nodecpu.WhatPrometheus, Reason: "no Prometheus reaches this cluster"})
	default:
		n.readPrometheus(ctx, &in, addresses, budget)
	}
	if len(in.Usage) == 0 {
		n.readCurrent(ctx, &in, scope, budget)
	}
	readable := n.readableNamespaces(ctx, &in, scope)
	in.Readable = func(ns string) bool { return readable[ns] }
	in.Queries = budget.spent
	return nodecpu.Analyze(in), !budget.failed, nil
}

// fillNodeInput takes the node's allocatable CPU and CPU requests from its describe, and gives its addresses.
func fillNodeInput(in *nodecpu.Input, desc map[string]interface{}) (addresses []string) {
	if allocatable, ok := desc["allocatable"].(map[string]string); ok {
		in.Allocatable, _ = nodecpu.Cores(allocatable["cpu"])
	}
	// for a grant limited to namespaces these cover its pods only, which is not the node's
	if rows, ok := desc["allocated_resources"].([]map[string]string); ok && desc["allocated_scope"] == nil {
		for _, row := range rows {
			if row["resource"] == "cpu" {
				in.Requests = row["requests"]
			}
		}
	}
	if list, ok := desc["addresses"].([]map[string]interface{}); ok {
		for _, a := range list {
			if kind, _ := a["type"].(string); strings.HasSuffix(kind, "IP") {
				address, _ := a["address"].(string)
				addresses = append(addresses, address)
			}
		}
	}
	return addresses
}

// readPrometheus reads the containers' cores over both windows, by the node's labels and, when no series has them, by the
// names of the node's pods; then, side by side, throttling, waiting, the node's CPUs and the node's waiting. At most six
// queries. A failed first query is not followed by others.
func (n *NodeNeighbors) readPrometheus(ctx context.Context, in *nodecpu.Input, addresses []string, budget *readBudget) {
	w := in.Window
	notRun := func(what, reason string) {
		in.NotRun = append(in.NotRun, nodecpu.NotRun{What: what, Reason: reason})
	}
	byNode := nodecpu.Selectors(in.Node, addresses)
	selectors := byNode
	got, err := n.series(ctx, budget, nodecpu.UsageQuery(w, selectors), w)
	usage, odd := nodecpu.ByContainer(w, got)
	if err == nil && len(usage) == 0 {
		if sel, left := nodecpu.PodSelector(in.Pods); sel != "" {
			selectors = []string{sel}
			got, err = n.series(ctx, budget, nodecpu.UsageQuery(w, selectors), w)
			var more int
			usage, more = nodecpu.ByContainer(w, got)
			odd += more
			in.ByPods = true
			if left > 0 {
				notRun(nodecpu.WhatUsage, fmt.Sprintf("the names of %d of the node's pods did not fit the query, so they are not in the rows", left))
			}
		}
	}
	if err != nil {
		notRun(nodecpu.WhatPrometheus, readFailure("Prometheus", err))
		return
	}
	if odd > 0 {
		notRun(nodecpu.WhatUsage, fmt.Sprintf("%d %s", odd, nodecpu.OddLabels))
	}
	if in.Usage = usage; len(in.Usage) > 0 && !nodecpu.Reaches(w, in.Usage) {
		in.Usage = nil
		notRun(nodecpu.WhatUsage, nodecpu.UsageEnded)
	}

	var (
		wg sync.WaitGroup
		mu sync.Mutex
	)
	run := func(what, query string, take func([]nodecpu.Series)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := n.series(ctx, budget, query, w)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				notRun(what, readFailure("Prometheus", err))
				return
			}
			take(got)
		}()
	}
	if len(in.Usage) > 0 {
		run(nodecpu.WhatThrottled, nodecpu.ThrottledQuery(w, selectors), func(s []nodecpu.Series) { in.Throttled, _ = nodecpu.ByContainer(w, s) })
		run(nodecpu.WhatWaiting, nodecpu.WaitingQuery(w, selectors), func(s []nodecpu.Series) { in.Waiting, _ = nodecpu.ByContainer(w, s) })
	}
	run(nodecpu.WhatCPUs, nodecpu.CPUsQuery(w, in.Node, byNode), func(s []nodecpu.Series) { in.CPUs = s })
	run(nodecpu.WhatNodeWaiting, nodecpu.NodeWaitingQuery(w, byNode), func(s []nodecpu.Series) {
		if len(s) > 0 {
			in.NodeWaiting = w.Grid(s[0].Points)
		}
	})
	wg.Wait()
}

var errReadBudgetSpent = errors.New("this answer's reads are spent")

// series is one range query over both windows, one evaluation a step.
func (n *NodeNeighbors) series(ctx context.Context, budget *readBudget, query string, w nodecpu.Window) ([]nodecpu.Series, error) {
	if !budget.take() {
		return nil, errReadBudgetSpent
	}
	ctx, cancel := context.WithTimeout(ctx, nodeNeighborsReadTimeout)
	defer cancel()
	rows, err := n.src.PrometheusQueryRange(ctx, query, w.QueryStart(), w.End, int(w.Step/time.Second))
	if err != nil {
		budget.fail()
		return nil, err
	}
	out := make([]nodecpu.Series, 0, len(rows))
	for _, row := range rows {
		s := nodecpu.Series{Labels: make(map[string]string, len(row.Metric)), Points: make([][2]float64, 0, len(row.Points))}
		for k, v := range row.Metric {
			s.Labels[k] = fmt.Sprint(v)
		}
		for _, p := range row.Points {
			s.Points = append(s.Points, [2]float64{p.T, p.V})
		}
		out = append(out, s)
	}
	return out, nil
}

// readCurrent reads the metrics API's current values of the node and of its pods within the reads left: the pods of the
// node's namespaces one list each, or one list of every namespace when those are more and the grant is not limited.
func (n *NodeNeighbors) readCurrent(ctx context.Context, in *nodecpu.Input, scope []string, budget *readBudget) {
	notRun := func(reason string) {
		in.NotRun = append(in.NotRun, nodecpu.NotRun{What: nodecpu.WhatCurrent, Reason: reason})
	}
	if budget.take() {
		c, cancel := context.WithTimeout(ctx, nodeNeighborsReadTimeout)
		rows, err := n.src.GetNodeMetrics(c)
		cancel()
		if err != nil {
			budget.fail()
			notRun(readFailure("the metrics API's nodes", err))
		}
		for _, row := range rows {
			if name, _ := row["name"].(string); name == in.Node {
				cpu, _ := row["cpu"].(string)
				if cores, ok := nodecpu.Cores(cpu); ok {
					in.CurrentNode = &cores
				}
			}
		}
	}
	namespaces := nodecpu.Namespaces(in.Pods)
	if left := budget.leftNow(); len(namespaces) > left {
		if len(scope) == 0 {
			namespaces = []string{""}
		} else {
			notRun(fmt.Sprintf("%d of the namespaces of your grant with pods on this node were not asked", len(namespaces)-left))
			namespaces = namespaces[:left]
		}
	}
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		rows []map[string]interface{}
	)
	for _, ns := range namespaces {
		if !budget.take() {
			break
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, cancel := context.WithTimeout(ctx, nodeNeighborsReadTimeout)
			defer cancel()
			got, err := n.src.GetPodMetrics(c, ns)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				budget.fail()
				notRun(readFailure("the metrics API's pods", err))
				return
			}
			rows = append(rows, got...)
		}()
	}
	wg.Wait()
	in.Current = nodecpu.CurrentFromRows(in.Pods, rows)
}

// readableNamespaces are the namespaces whose pods may be named though they are not on the node now: all that have a
// series when the node's pods were listed across the cluster, those of a limited grant, and when the pods could not be
// listed those the cluster lets the caller list pods in (the ones that used the most asked, nodeNeighborsReviews at most).
func (n *NodeNeighbors) readableNamespaces(ctx context.Context, in *nodecpu.Input, scope []string) map[string]bool {
	used := map[string]float64{}
	for k, g := range in.Usage {
		for _, v := range g {
			if v > 0 {
				used[k.Namespace] += v
			}
		}
		used[k.Namespace] += 0
	}
	out := map[string]bool{}
	var ask []string
	for ns := range used {
		switch {
		case len(scope) > 0 && !slices.Contains(scope, ns):
		case in.PodsError == "":
			out[ns] = true
		default:
			ask = append(ask, ns)
		}
	}
	sort.Slice(ask, func(i, j int) bool {
		if used[ask[i]] != used[ask[j]] {
			return used[ask[i]] > used[ask[j]]
		}
		return ask[i] < ask[j]
	})
	var (
		wg sync.WaitGroup
		mu sync.Mutex
	)
	for _, ns := range ask[:min(len(ask), nodeNeighborsReviews)] {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, err := n.mayListPods(ctx, ns); err == nil && ok {
				mu.Lock()
				out[ns] = true
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return out
}

// readBudget counts one answer's reads of the metrics store and the metrics API, and whether one failed.
type readBudget struct {
	mu     sync.Mutex
	left   int
	spent  int
	failed bool
}

func (b *readBudget) fail() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failed = true
}

func (b *readBudget) take() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.left == 0 {
		return false
	}
	b.left--
	b.spent++
	return true
}

func (b *readBudget) leftNow() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.left
}

// nodeAnswersMax bounds the answers kept: past it the oldest goes.
const nodeAnswersMax = 256

type nodeAnswer struct {
	at     time.Time
	result nodecpu.Result
}

// nodeAnswers keeps each answer for nodeNeighborsCache, keyed by cluster, claims, node and window.
type nodeAnswers struct {
	mu      sync.Mutex
	entries map[string]nodeAnswer
}

func (c *nodeAnswers) get(key string, now time.Time) (nodecpu.Result, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || now.Sub(e.at) >= nodeNeighborsCache {
		return nodecpu.Result{}, false
	}
	return e.result, true
}

func (c *nodeAnswers) put(key string, now time.Time, result nodecpu.Result) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]nodeAnswer{}
	}
	oldest, oldestAt := "", now
	for k, e := range c.entries {
		if now.Sub(e.at) >= nodeNeighborsCache {
			delete(c.entries, k)
			continue
		}
		if e.at.Before(oldestAt) {
			oldest, oldestAt = k, e.at
		}
	}
	if len(c.entries) >= nodeAnswersMax && oldest != "" {
		delete(c.entries, oldest)
	}
	c.entries[key] = nodeAnswer{at: now, result: result}
}
