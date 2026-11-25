// The line get_node_metrics without a node adds with NODE_NEIGHBORS_BUSIEST_CPU (chart features.nodeNeighbors.busiestCPU,
// off by default, nothing without features.nodeNeighbors.enabled): the busiest CPU of the cluster's nodes and the pods
// that used the most CPU on its node, which k8s-service reads and writes as the caller (internal/nodecpu). Off, the answer
// is kubectl top nodes' rows as before.

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/config"
)

const (
	busiestTimeout = 15 * time.Second
	// busiestLineChars holds the line of five pods with the longest names a Pod can have, cut past it.
	busiestLineChars = 2500
)

func nodeBusiestOn() bool {
	return config.EnvSwitch("NODE_NEIGHBORS_ENABLED") && config.EnvSwitch("NODE_NEIGHBORS_BUSIEST_CPU")
}

// nodeMetricsAnswer is the nodes' usage rows, with the line in front of them when it is on and k8s-service has it.
func nodeMetricsAnswer(ctx context.Context, headers http.Header, nodes []map[string]interface{}) (string, error) {
	line := busiestCPULine(ctx, headers)
	if line == "" {
		return marshalJSON(nodes)
	}
	return marshalOrdered(map[string]interface{}{"busiest_cpu": line, "nodes": nodes}, []string{"busiest_cpu"}, []string{"nodes"})
}

// busiestCPULine is the line, why it could not be read, or "" where it is off (here, or in k8s-service).
func busiestCPULine(ctx context.Context, headers http.Header) string {
	if !nodeBusiestOn() {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, busiestTimeout)
	defer cancel()
	status, body, err := k8sServiceGet(ctx, headers, "/metrics/nodes/busiest-cpu", nil)
	if status == http.StatusNotFound {
		return ""
	}
	var reply struct {
		Line string `json:"line"`
	}
	if err == nil && status == http.StatusOK && json.Unmarshal(body, &reply) == nil && reply.Line != "" {
		return headOf(reply.Line, busiestLineChars)
	}
	why := "k8s-service did not answer"
	if err == nil {
		if detail := detailOf(body); detail != "" {
			why = headOf(detail, 300)
		}
	}
	return "The nodes' busiest CPU and the pods that used it were not read (" + why + "): a node's percentage is the average over its CPUs, in which one full CPU does not show."
}
