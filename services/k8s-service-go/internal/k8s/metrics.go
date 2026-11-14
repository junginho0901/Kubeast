package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// PodMetrics represents the metrics.k8s.io pod metrics response.
type podMetricsResponse struct {
	Items []podMetricsItem `json:"items"`
}

type podMetricsItem struct {
	Metadata struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
	} `json:"metadata"`
	Containers []containerMetrics `json:"containers"`
	Timestamp  string             `json:"timestamp"`
	Window     string             `json:"window"`
}

type containerMetrics struct {
	Name  string            `json:"name"`
	Usage map[string]string `json:"usage"`
}

// NodeMetrics represents the metrics.k8s.io node metrics response.
type nodeMetricsResponse struct {
	Items []nodeMetricsItem `json:"items"`
}

type nodeMetricsItem struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Usage     map[string]string `json:"usage"`
	Timestamp string            `json:"timestamp"`
	Window    string            `json:"window"`
}

// GetPodMetrics returns pod metrics for a namespace (or all namespaces) with aggregated cpu/memory per pod.
func (s *Service) GetPodMetrics(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	if namespace == "" {
		return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) { return s.podMetricsIn(ctx, ns) })
	}
	return s.podMetricsIn(ctx, namespace)
}

func podMetricsPath(namespace string) string {
	if namespace == "" {
		return "/apis/metrics.k8s.io/v1beta1/pods"
	}
	return fmt.Sprintf("/apis/metrics.k8s.io/v1beta1/namespaces/%s/pods", namespace)
}

func (s *Service) podMetricsIn(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	rawBody, statusCode, err := s.metricsListRead(ctx, podMetricsPath(namespace))
	if err != nil {
		return nil, metricsReadError("pod", statusCode, err)
	}

	var resp podMetricsResponse
	if err := json.Unmarshal(rawBody, &resp); err != nil {
		return nil, fmt.Errorf("parse pod metrics: %w", err)
	}

	result := make([]map[string]interface{}, 0, len(resp.Items))
	for _, item := range resp.Items {
		// Aggregate CPU/memory across all containers
		var totalCPUNano int64
		var totalMemBytes int64
		containers := make([]map[string]interface{}, 0, len(item.Containers))
		for _, c := range item.Containers {
			totalCPUNano += cpuToNanoCores(c.Usage["cpu"])
			totalMemBytes += memoryToBytes(c.Usage["memory"])
			containers = append(containers, map[string]interface{}{
				"name":   c.Name,
				"cpu":    c.Usage["cpu"],
				"memory": c.Usage["memory"],
			})
		}

		cpuMillis := topMillicores(totalCPUNano)
		memMi := totalMemBytes / (1 << 20)

		result = append(result, map[string]interface{}{
			"name":       item.Metadata.Name,
			"namespace":  item.Metadata.Namespace,
			"cpu":        fmt.Sprintf("%dm", cpuMillis),
			"memory":     fmt.Sprintf("%dMi", memMi),
			"containers": containers,
			"timestamp":  item.Timestamp,
		})
	}
	return result, nil
}

// AddPodLimits puts each pod's cpu_limit_millicores and memory_limit_bytes (nil without a limit) on the metric
// rows, from the pod rows the caller may see in namespace. A caller who may not list pods gets the rows as they are.
func (s *Service) AddPodLimits(ctx context.Context, namespace string, rows []map[string]interface{}) {
	set, err := s.callerPodRows(ctx, namespace, "")
	if err != nil {
		slog.Debug("pod metrics: no limits", "namespace", namespace, "err", err)
		return
	}
	defer set.done()
	byName := make(map[string]*podRow, len(set.rows))
	for _, r := range set.rows {
		byName[r.namespace+"/"+r.name] = r
	}
	orNil := func(v int64) interface{} {
		if v < 0 {
			return nil
		}
		return v
	}
	for _, row := range rows {
		ns, _ := row["namespace"].(string)
		name, _ := row["name"].(string)
		if r := byName[ns+"/"+name]; r != nil {
			row["cpu_limit_millicores"] = orNil(r.cpuLimitMilli)
			row["memory_limit_bytes"] = orNil(r.memLimitBytes)
		}
	}
}

// ErrMetricsNotServed: the cluster serves no metrics.k8s.io (no metrics-server), which Monitoring's reads answer as a 404
// in the words top-resources gives it, "the server could not find the requested resource".
var ErrMetricsNotServed = errors.New("metrics.k8s.io not served")

// metricsNotServedError is that answer: the cluster's 404 as RawRequest words it. It does not unwrap to the 404, so a grant
// limited to namespaces does not skip it as a namespace the cluster does not have.
type metricsNotServedError struct{ err error }

func (e metricsNotServedError) Error() string        { return e.err.Error() }
func (e metricsNotServedError) Is(target error) bool { return target == ErrMetricsNotServed }

// metricsReadError is the failure of Monitoring's pod or node metrics read. A refusal stays as the cluster wrote it, as
// top-resources gives it; metrics.k8s.io not served is ErrMetricsNotServed; another failure says which read and the status.
func metricsReadError(what string, status int, err error) error {
	if apierrors.IsForbidden(err) {
		return err
	}
	if metricsNotServed(status, err) {
		return metricsNotServedError{err: err}
	}
	return fmt.Errorf("get %s metrics (status %d): %w", what, status, err)
}

// GetNodeMetrics returns node metrics with cpu_percent and memory_percent.
func (s *Service) GetNodeMetrics(ctx context.Context) ([]map[string]interface{}, error) {
	rawBody, statusCode, err := s.metricsListRead(ctx, "/apis/metrics.k8s.io/v1beta1/nodes")
	if err != nil {
		return nil, metricsReadError("node", statusCode, err)
	}

	var resp nodeMetricsResponse
	if err := json.Unmarshal(rawBody, &resp); err != nil {
		return nil, fmt.Errorf("parse node metrics: %w", err)
	}

	alloc := s.nodeAllocatables(ctx)

	result := make([]map[string]interface{}, 0, len(resp.Items))
	for _, item := range resp.Items {
		result = append(result, nodeUsage(item.Metadata.Name, cpuToNanoCores(item.Usage["cpu"]), memoryToBytes(item.Usage["memory"]), item.Timestamp, alloc))
	}
	return result, nil
}

// TopSkip is what a top-resources read leaves out, top_pods or top_nodes with its error: a part the cluster refused the
// caller, which the screen keeps from that answer instead of asking again.
type TopSkip struct{ Pods, Nodes bool }

// GetTopResources returns the top N pods and nodes by CPU usage descending. A part that could not be read has its
// error, and pod_metrics_refused or node_metrics_refused when the cluster refused it.
func (s *Service) GetTopResources(ctx context.Context, podLimit, nodeLimit int, skip TopSkip) (map[string]interface{}, error) {
	if podLimit <= 0 {
		podLimit = 10
	}
	if nodeLimit <= 0 {
		nodeLimit = 10
	}

	result := map[string]interface{}{}

	// Pod metrics across all namespaces, or each of a limited grant's namespaces
	if !skip.Pods {
		s.addTopPods(ctx, result, podLimit)
	}
	if !skip.Nodes {
		s.addTopNodes(ctx, result, nodeLimit)
	}
	return result, nil
}

// addTopPods puts top_pods in result, or the reason they could not be read.
func (s *Service) addTopPods(ctx context.Context, result map[string]interface{}, podLimit int) {
	podItems, podErr := s.topPodItems(ctx)
	if podErr == nil {
		pods := make([]map[string]interface{}, 0, len(podItems))
		for _, item := range podItems {
			var totalCPUNano int64
			var totalMemBytes int64
			for _, c := range item.Containers {
				totalCPUNano += cpuToNanoCores(c.Usage["cpu"])
				totalMemBytes += memoryToBytes(c.Usage["memory"])
			}
			pods = append(pods, map[string]interface{}{
				"name":      item.Metadata.Name,
				"namespace": item.Metadata.Namespace,
				"cpu":       fmt.Sprintf("%dm", topMillicores(totalCPUNano)),
				"memory":    fmt.Sprintf("%dMi", totalMemBytes/(1<<20)),
				"timestamp": item.Timestamp,
			})
		}

		// Sort by CPU usage descending
		sort.Slice(pods, func(i, j int) bool {
			ci, _ := pods[i]["cpu"].(string)
			cj, _ := pods[j]["cpu"].(string)
			return cpuToNanoCores(ci) > cpuToNanoCores(cj)
		})

		if len(pods) > podLimit {
			pods = pods[:podLimit]
		}
		result["top_pods"] = pods
		return
	}
	result["top_pods"] = []map[string]interface{}{}
	result["pod_metrics_error"] = response.Public(podErr)
	if apierrors.IsForbidden(podErr) {
		result["pod_metrics_refused"] = true
	}
}

// addTopNodes puts top_nodes in result with their share of the allocatable, or the reason they could not be read.
func (s *Service) addTopNodes(ctx context.Context, result map[string]interface{}, nodeLimit int) {
	nodeBody, _, nodeErr := s.metricsListRead(ctx, "/apis/metrics.k8s.io/v1beta1/nodes")
	if nodeErr == nil {
		var nodeResp nodeMetricsResponse
		if err := json.Unmarshal(nodeBody, &nodeResp); err == nil {
			alloc := s.nodeAllocatables(ctx)

			nodes := make([]map[string]interface{}, 0, len(nodeResp.Items))
			for _, item := range nodeResp.Items {
				nodes = append(nodes, nodeUsage(item.Metadata.Name, cpuToNanoCores(item.Usage["cpu"]), memoryToBytes(item.Usage["memory"]), item.Timestamp, alloc))
			}

			sort.Slice(nodes, func(i, j int) bool {
				ci, _ := nodes[i]["cpu"].(string)
				cj, _ := nodes[j]["cpu"].(string)
				return cpuToNanoCores(ci) > cpuToNanoCores(cj)
			})

			if len(nodes) > nodeLimit {
				nodes = nodes[:nodeLimit]
			}
			result["top_nodes"] = nodes
		}
		return
	}
	result["top_nodes"] = []map[string]interface{}{}
	result["node_metrics_error"] = response.Public(nodeErr)
	if apierrors.IsForbidden(nodeErr) {
		result["node_metrics_refused"] = true
	}
}

// topPodItems is the pod metrics top-resources ranks: one list of every namespace, or for a grant limited to
// namespaces one list per namespace, listFanOutWorkers at a time (sideBySide). eachCallerNamespace then takes their
// answers in the grant's order as if it had asked them in turn, so the rows, their order and the error are what one
// request after another gives. A failure that ends that turn keeps the namespaces after it that have not started from
// being asked; those already under way finish.
func (s *Service) topPodItems(ctx context.Context) ([]podMetricsItem, error) {
	scope := scopeFromCtx(ctx)
	if len(scope) == 0 {
		return s.podMetricItems(ctx, "")
	}
	items := make([][]podMetricsItem, len(scope))
	errs := make([]error, len(scope))
	var stop atomic.Int64 // the first namespace whose failure ends the turn
	stop.Store(int64(len(scope)))
	sideBySide(len(scope), func(i int) {
		if int64(i) > stop.Load() {
			return
		}
		items[i], errs[i] = s.podMetricItems(ctx, scope[i])
		if err := errs[i]; err == nil || apierrors.IsForbidden(err) || apierrors.IsNotFound(err) {
			return
		}
		for at := stop.Load(); int64(i) < at; at = stop.Load() {
			if stop.CompareAndSwap(at, int64(i)) {
				break
			}
		}
	})
	var out []podMetricsItem
	next := 0
	err := eachCallerNamespace(ctx, "", func(string) error {
		i := next
		next++
		out = append(out, items[i]...)
		return errs[i]
	})
	return out, err
}

// podMetricItems is one metrics.k8s.io list of the pods in namespace ("" = every namespace). An answer that does not
// parse is no rows.
func (s *Service) podMetricItems(ctx context.Context, namespace string) ([]podMetricsItem, error) {
	body, _, err := s.metricsListRead(ctx, podMetricsPath(namespace))
	if err != nil {
		return nil, err
	}
	var resp podMetricsResponse
	if json.Unmarshal(body, &resp) != nil {
		return nil, nil
	}
	return resp.Items, nil
}

// metricsGroup is the API group metrics-server serves.
const metricsGroup = "metrics.k8s.io"

// metricsListRead is metricsRequest for one of the metrics.k8s.io lists of top-resources and Monitoring's Nodes and Pods
// tabs, asked only of a cluster whose API discovery serves metrics.k8s.io (servesGroup). On a cluster without
// metrics-server every caller gets, without a request, the answer the API server gives an identity it lets list them:
// the 404 for a path no API group serves, "the server could not find the requested resource". The API server refuses a
// list (403) before it looks for the path, so asking would give a caller it refuses its refusal and the others the 404;
// discovery is the same for every signed-in identity. On a cluster that serves metrics.k8s.io each caller's own answer
// stands: its rows, its refusal, a failure.
func (s *Service) metricsListRead(ctx context.Context, path string) ([]byte, int, error) {
	if !s.servesGroup(ctx, metricsGroup) {
		accesstrail.Cached(ctx, "metrics.k8s.io not served: the cluster's API discovery, read within the last minute")
		return nil, http.StatusNotFound, metricsAPINotServed()
	}
	return s.metricsRequest(ctx, path)
}

// metricsAPINotServed is the error RawRequest makes of the API server's 404 for a metrics.k8s.io list on a cluster that
// does not serve the group.
func metricsAPINotServed() error {
	return apierrors.NewGenericServerResponse(http.StatusNotFound, http.MethodGet, schema.GroupResource{}, "", "", 0, true)
}

// metricsRequest is RawRequest that gives a failure as the cluster wrote it: RawRequest leaves the body of a failure
// unread, so a refusal written as a Status reads "unknown". A 404 stays in RawRequest's words, "the server could not
// find the requested resource", which the dashboard reads as no metrics-server.
func (s *Service) metricsRequest(ctx context.Context, path string) ([]byte, int, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, http.StatusServiceUnavailable, errNotLoaded
	}
	result := cs.RESTClient().Get().AbsPath(path).Do(ctx)
	body, err := result.Raw()
	var status int
	result.StatusCode(&status)
	if status == 0 {
		status = http.StatusInternalServerError
	}
	if err != nil && status != http.StatusNotFound {
		err = result.Error()
	}
	return body, status, err
}

// metricsNotServed is a 404 for one of those lists: the API server's for a path no API group serves, which RawRequest
// reads as "the server could not find the requested resource" whatever the body, as the dashboard reads it.
func metricsNotServed(status int, err error) bool {
	return status == http.StatusNotFound && apierrors.IsNotFound(err)
}

// nodeAllocatable is a node's allocatable CPU (millicores) and memory (bytes).
type nodeAllocatable struct{ cpuMilli, memBytes int64 }

func allocatableOf(n *corev1.Node) nodeAllocatable {
	return nodeAllocatable{cpuMilli: n.Status.Allocatable.Cpu().MilliValue(), memBytes: n.Status.Allocatable.Memory().Value()}
}

// nodeAllocatables reads the nodes' allocatable resources from the cluster's informer store when it is running,
// otherwise lists nodes. Errors yield an empty map (no percentages).
func (s *Service) nodeAllocatables(ctx context.Context) map[string]nodeAllocatable {
	if b := s.bundleForCtx(ctx); b != nil {
		if ci := b.syncedInformers(); ci != nil {
			accesstrail.Cached(ctx, "node allocatable from the overview informers (watched as "+overviewCacheUser+")")
			return ci.nodeAllocatables()
		}
	}
	out := map[string]nodeAllocatable{}
	nodes, err := s.clientsetCtx(ctx).CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return out
	}
	for i := range nodes.Items {
		out[nodes.Items[i].Name] = allocatableOf(&nodes.Items[i])
	}
	return out
}

// The numbers kubectl top prints (k8s.io/kubectl metricsutil, release-1.37): CPU as the quantity's MilliValue — the
// nanocores rounded up to a millicore, a pod's containers summed first — memory in Mi rounded down, and a node's
// share of its Allocatable (Capacity only with --show-capacity) cut to a whole percent.
func topMillicores(nano int64) int64 { return (nano + 999_999) / 1_000_000 }

func topPercent(used, available int64) string {
	return fmt.Sprintf("%d%%", int64(float64(used)/float64(available)*100))
}

// nodeUsage is a node's metric row as kubectl top node prints it.
func nodeUsage(name string, cpuNano, memBytes int64, timestamp string, alloc map[string]nodeAllocatable) map[string]interface{} {
	cpuMilli := topMillicores(cpuNano)
	entry := map[string]interface{}{
		"name":      name,
		"cpu":       fmt.Sprintf("%dm", cpuMilli),
		"memory":    fmt.Sprintf("%dMi", memBytes/(1<<20)),
		"timestamp": timestamp,
	}
	if a, ok := alloc[name]; ok {
		if a.cpuMilli > 0 {
			entry["cpu_percent"] = topPercent(cpuMilli, a.cpuMilli)
		}
		if a.memBytes > 0 {
			entry["memory_percent"] = topPercent(memBytes, a.memBytes)
		}
	}
	return entry
}

// cpuToNanoCores converts a Kubernetes CPU quantity string to nanocores for sorting.
func cpuToNanoCores(q string) int64 {
	q = strings.TrimSpace(q)
	if q == "" {
		return 0
	}
	if strings.HasSuffix(q, "n") {
		var n int64
		fmt.Sscanf(strings.TrimSuffix(q, "n"), "%d", &n)
		return n
	}
	if strings.HasSuffix(q, "u") {
		var n int64
		fmt.Sscanf(strings.TrimSuffix(q, "u"), "%d", &n)
		return n * 1000
	}
	if strings.HasSuffix(q, "m") {
		var n int64
		fmt.Sscanf(strings.TrimSuffix(q, "m"), "%d", &n)
		return n * 1000000
	}
	var n int64
	fmt.Sscanf(q, "%d", &n)
	return n * 1000000000
}

// addCPUQuantities adds two CPU quantity strings and returns the sum as a nanocores string.
func addCPUQuantities(a, b string) string {
	na := cpuToNanoCores(a)
	nb := cpuToNanoCores(b)
	total := na + nb
	if total == 0 {
		return b
	}
	return fmt.Sprintf("%dn", total)
}

// addMemoryQuantities adds two memory quantity strings by parsing to bytes.
func addMemoryQuantities(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	ba := memoryToBytes(a)
	bb := memoryToBytes(b)
	total := ba + bb
	if total > 0 {
		return fmt.Sprintf("%dKi", total/1024)
	}
	return b
}

// memoryToBytes converts a Kubernetes memory quantity to bytes.
func memoryToBytes(q string) int64 {
	q = strings.TrimSpace(q)
	if q == "" {
		return 0
	}
	suffixes := []struct {
		suffix     string
		multiplier int64
	}{
		{"Ei", 1 << 60}, {"Pi", 1 << 50}, {"Ti", 1 << 40},
		{"Gi", 1 << 30}, {"Mi", 1 << 20}, {"Ki", 1 << 10},
		{"E", 1000000000000000000}, {"P", 1000000000000000},
		{"T", 1000000000000}, {"G", 1000000000},
		{"M", 1000000}, {"k", 1000},
	}
	for _, s := range suffixes {
		if strings.HasSuffix(q, s.suffix) {
			var n int64
			fmt.Sscanf(strings.TrimSuffix(q, s.suffix), "%d", &n)
			return n * s.multiplier
		}
	}
	var n int64
	fmt.Sscanf(q, "%d", &n)
	return n
}
