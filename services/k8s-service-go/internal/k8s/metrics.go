package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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
	var path string
	if namespace == "" {
		path = "/apis/metrics.k8s.io/v1beta1/pods"
	} else {
		path = fmt.Sprintf("/apis/metrics.k8s.io/v1beta1/namespaces/%s/pods", namespace)
	}
	rawBody, statusCode, err := s.RawRequest(ctx, "GET", path)
	if err != nil {
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

		cpuMillis := totalCPUNano / 1000000
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

// GetNodeMetrics returns node metrics with cpu_percent and memory_percent.
func (s *Service) GetNodeMetrics(ctx context.Context) ([]map[string]interface{}, error) {
	path := "/apis/metrics.k8s.io/v1beta1/nodes"
	rawBody, statusCode, err := s.RawRequest(ctx, "GET", path)
	if err != nil {
		return nil, fmt.Errorf("get node metrics (status %d): %w", statusCode, err)
	}

	var resp nodeMetricsResponse
	if err := json.Unmarshal(rawBody, &resp); err != nil {
		return nil, fmt.Errorf("parse node metrics: %w", err)
	}

	// Fetch node capacity for percentage calculation
	nodeCapacity := make(map[string]struct{ cpuNano, memBytes int64 })
	nodes, listErr := s.Clientset().CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if listErr == nil {
		for _, n := range nodes.Items {
			cpuQ := n.Status.Capacity.Cpu()
			memQ := n.Status.Capacity.Memory()
			nodeCapacity[n.Name] = struct{ cpuNano, memBytes int64 }{
				cpuNano:  cpuQ.MilliValue() * 1000000, // milliCPU -> nanoCPU
				memBytes: memQ.Value(),
			}
		}
	}

	result := make([]map[string]interface{}, 0, len(resp.Items))
	for _, item := range resp.Items {
		usageCPUNano := cpuToNanoCores(item.Usage["cpu"])
		usageMemBytes := memoryToBytes(item.Usage["memory"])

		cpuMillis := usageCPUNano / 1000000
		memMi := usageMemBytes / (1 << 20)

		entry := map[string]interface{}{
			"name":      item.Metadata.Name,
			"cpu":       fmt.Sprintf("%dm", cpuMillis),
			"memory":    fmt.Sprintf("%dMi", memMi),
			"timestamp": item.Timestamp,
		}

		// Calculate percentages if capacity is available
		if cap, ok := nodeCapacity[item.Metadata.Name]; ok {
			if cap.cpuNano > 0 {
				cpuPct := float64(usageCPUNano) / float64(cap.cpuNano) * 100
				entry["cpu_percent"] = fmt.Sprintf("%.0f%%", cpuPct)
			}
			if cap.memBytes > 0 {
				memPct := float64(usageMemBytes) / float64(cap.memBytes) * 100
				entry["memory_percent"] = fmt.Sprintf("%.0f%%", memPct)
			}
		}

		result = append(result, entry)
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

	// Pod metrics across all namespaces
	podBody, _, podErr := s.RawRequest(ctx, "GET", "/apis/metrics.k8s.io/v1beta1/pods")
	if podErr == nil {
		var podResp podMetricsResponse
		if err := json.Unmarshal(podBody, &podResp); err == nil {
			pods := make([]map[string]interface{}, 0, len(podResp.Items))
			for _, item := range podResp.Items {
				var totalCPUNano int64
				var totalMemBytes int64
				for _, c := range item.Containers {
					totalCPUNano += cpuToNanoCores(c.Usage["cpu"])
					totalMemBytes += memoryToBytes(c.Usage["memory"])
				}
				pods = append(pods, map[string]interface{}{
					"name":      item.Metadata.Name,
					"namespace": item.Metadata.Namespace,
					"cpu":       fmt.Sprintf("%dm", totalCPUNano/1000000),
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
		}
	} else {
		result["top_pods"] = []map[string]interface{}{}
		result["pod_metrics_error"] = podErr.Error()
	}

	// Node metrics with capacity percentages
	nodeBody, _, nodeErr := s.RawRequest(ctx, "GET", "/apis/metrics.k8s.io/v1beta1/nodes")
	if nodeErr == nil {
		var nodeResp nodeMetricsResponse
		if err := json.Unmarshal(nodeBody, &nodeResp); err == nil {
			// Fetch node capacity
			nodeCapacity := make(map[string]struct{ cpuNano, memBytes int64 })
			nodeList, listErr := s.Clientset().CoreV1().Nodes().List(ctx, metav1.ListOptions{})
			if listErr == nil {
				for _, n := range nodeList.Items {
					nodeCapacity[n.Name] = struct{ cpuNano, memBytes int64 }{
						cpuNano:  n.Status.Capacity.Cpu().MilliValue() * 1000000,
						memBytes: n.Status.Capacity.Memory().Value(),
					}
				}
			}

			nodes := make([]map[string]interface{}, 0, len(nodeResp.Items))
			for _, item := range nodeResp.Items {
				cpuNano := cpuToNanoCores(item.Usage["cpu"])
				memBytes := memoryToBytes(item.Usage["memory"])
				entry := map[string]interface{}{
					"name":      item.Metadata.Name,
					"cpu":       fmt.Sprintf("%dm", cpuNano/1000000),
					"memory":    fmt.Sprintf("%dMi", memBytes/(1<<20)),
					"timestamp": item.Timestamp,
				}
				if cap, ok := nodeCapacity[item.Metadata.Name]; ok {
					if cap.cpuNano > 0 {
						entry["cpu_percent"] = fmt.Sprintf("%.0f%%", float64(cpuNano)/float64(cap.cpuNano)*100)
					}
					if cap.memBytes > 0 {
						entry["memory_percent"] = fmt.Sprintf("%.0f%%", float64(memBytes)/float64(cap.memBytes)*100)
					}
				}
				nodes = append(nodes, entry)
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
