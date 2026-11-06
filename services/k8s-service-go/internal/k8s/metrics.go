package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
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
	rawBody, statusCode, err := s.RawRequest(ctx, "GET", podMetricsPath(namespace))
	if err != nil {
		// metrics-server not installed in this cluster → the metrics.k8s.io API
		// group is unregistered (404). That's "no metrics", not a server error;
		// return empty so callers degrade gracefully instead of surfacing a 500.
		if statusCode == http.StatusNotFound {
			return []map[string]interface{}{}, nil
		}
		return nil, fmt.Errorf("get pod metrics (status %d): %w", statusCode, err)
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

// GetNodeMetrics returns node metrics with cpu_percent and memory_percent.
func (s *Service) GetNodeMetrics(ctx context.Context) ([]map[string]interface{}, error) {
	path := "/apis/metrics.k8s.io/v1beta1/nodes"
	rawBody, statusCode, err := s.RawRequest(ctx, "GET", path)
	if err != nil {
		if statusCode == http.StatusNotFound {
			return []map[string]interface{}{}, nil
		}
		return nil, fmt.Errorf("get node metrics (status %d): %w", statusCode, err)
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

// GetTopResources returns the top N pods and nodes by CPU usage descending.
func (s *Service) GetTopResources(ctx context.Context, podLimit, nodeLimit int) (map[string]interface{}, error) {
	if podLimit <= 0 {
		podLimit = 10
	}
	if nodeLimit <= 0 {
		nodeLimit = 10
	}

	result := map[string]interface{}{}

	// Pod metrics across all namespaces, each of a limited grant's namespaces in turn
	var podItems []podMetricsItem
	podErr := eachCallerNamespace(ctx, "", func(ns string) error {
		podBody, _, err := s.RawRequest(ctx, "GET", podMetricsPath(ns))
		if err != nil {
			return err
		}
		var podResp podMetricsResponse
		if json.Unmarshal(podBody, &podResp) == nil {
			podItems = append(podItems, podResp.Items...)
		}
		return nil
	})
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
	} else {
		result["top_pods"] = []map[string]interface{}{}
		result["pod_metrics_error"] = podErr.Error()
	}

	// Node metrics with their share of the allocatable
	nodeBody, _, nodeErr := s.RawRequest(ctx, "GET", "/apis/metrics.k8s.io/v1beta1/nodes")
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
	} else {
		result["top_nodes"] = []map[string]interface{}{}
		result["node_metrics_error"] = nodeErr.Error()
	}

	return result, nil
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
