package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nodecpu"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// busiestTimeout bounds one busiest CPU answer, which comes beside the nodes' current usage.
const busiestTimeout = 12 * time.Second

// NodeBusiestOn is features.nodeNeighbors.busiestCPU (NODE_NEIGHBORS_BUSIEST_CPU), off by default and nothing without
// features.nodeNeighbors.enabled.
func NodeBusiestOn() bool {
	return NodeNeighborsOn() && pkgconfig.EnvSwitch("NODE_NEIGHBORS_BUSIEST_CPU")
}

// Busiest handles GET /api/v1/metrics/nodes/busiest-cpu: the busiest CPU of the cluster's nodes in the last hour and the
// pods that used the most CPU on its node then, as one line (internal/nodecpu). The nodes and that node's pods are read as
// the caller, the metrics as Get reads them, and what the caller may not list is counted, not named. The same caller
// asking within a minute gets the answer they got.
func (n *NodeNeighbors) Busiest(w http.ResponseWriter, r *http.Request) {
	if !n.on || !n.busiest {
		response.Error(w, http.StatusNotFound, "the busiest CPU is off (features.nodeNeighbors.busiestCPU)")
		return
	}
	ctx := r.Context()
	now := n.now()
	win := nodecpu.BusiestWindow(now)
	id, _ := cluster.FromContext(ctx)
	payload, _ := auth.FromContext(ctx)
	claims := payload.ClaimsKey()
	key := strings.Join([]string{string(id), claims, win.End.UTC().Format(time.RFC3339)}, "|")
	if res, ok := n.lines.get(key, now); ok && claims != "" {
		accesstrail.Cached(ctx, "the same busiest CPU a moment ago")
		response.JSON(w, http.StatusOK, res)
		return
	}
	res, whole, err := n.readBusiest(ctx, win, payload.Namespaces[string(id)])
	if err != nil {
		n.h.handleError(w, err)
		return
	}
	if claims != "" && whole {
		n.lines.put(key, now, res)
	}
	response.JSON(w, http.StatusOK, res)
}

// readBusiest reads the nodes, their busiest CPUs, and of the busiest one's node its CPUs, containers and pods. Only the
// list of nodes is needed: what else could not be read is said in the line, which is whole when none of its reads failed.
func (n *NodeNeighbors) readBusiest(ctx context.Context, win nodecpu.Window, scope []string) (res nodecpu.BusiestResult, whole bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, busiestTimeout)
	defer cancel()
	rows, err := n.src.GetNodes(ctx)
	if err != nil {
		return res, false, err
	}
	nodes, cpus := nodecpu.NodesFromRows(rows)
	in := nodecpu.BusiestInput{Input: nodecpu.Input{Window: win}, Nodes: len(nodes)}
	budget := &readBudget{left: nodecpu.BusiestQueries}
	switch {
	case len(scope) > 0:
		in.Why = "the cluster's Prometheus covers the whole cluster; your grant on this cluster is limited to namespaces"
	case !n.src.PrometheusAvailable(ctx):
		in.Why = "no Prometheus reaches this cluster"
	case cpus > nodecpu.BusiestMaxCPUs:
		in.Why = fmt.Sprintf("the %d nodes have %.0f CPUs together, more than the %d read at once: get_node_metrics with node reads one", len(nodes), cpus, nodecpu.BusiestMaxCPUs)
	default:
		n.readBusiestNode(ctx, &in, nodes, budget)
	}
	in.Queries = budget.spent
	return nodecpu.Busiest(in), !budget.failed, nil
}

// readBusiestNode finds the node of the busiest CPU, and reads its CPUs, its containers' cores and its pods.
func (n *NodeNeighbors) readBusiestNode(ctx context.Context, in *nodecpu.BusiestInput, nodes []nodecpu.Node, budget *readBudget) {
	w := in.Window
	top, err := n.series(ctx, budget, nodecpu.BusiestQuery(w), w)
	if err != nil {
		in.Why = readFailure("Prometheus", err)
		return
	}
	node, ok := nodecpu.BusiestNode(w, top, nodes)
	if !ok {
		in.Why = nodecpu.NoCPUsOfNodes
		return
	}
	in.Node = node.Name
	selectors := nodecpu.Selectors(node.Name, node.Addresses)
	var (
		wg             sync.WaitGroup
		pods           []map[string]interface{}
		podErr, cpuErr error
		useErr         error
		used           []nodecpu.Series
	)
	for _, read := range []func(){
		func() { pods, podErr = n.src.GetNodePods(ctx, node.Name) },
		func() { in.CPUs, cpuErr = n.series(ctx, budget, nodecpu.CPUsQuery(w, node.Name, selectors), w) },
		func() { used, useErr = n.series(ctx, budget, nodecpu.UsageQuery(w, selectors), w) },
	} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			read()
		}()
	}
	wg.Wait()
	if cpuErr != nil {
		in.Why = readFailure("Prometheus", cpuErr)
		return
	}
	in.Pods = nodecpu.PodsFromRows(pods)
	if podErr != nil {
		budget.fail()
		in.PodsError = readFailure("the pods on the node", podErr)
	}
	in.Usage, _ = nodecpu.ByContainer(w, used)
	if useErr == nil && len(in.Usage) == 0 {
		in.Usage, useErr = n.usageByPods(ctx, in, budget)
	}
	if useErr != nil {
		in.UsageWhy = readFailure("Prometheus", useErr)
		return
	}
	readable := n.readableNamespaces(ctx, &in.Input, nil)
	in.Readable = func(ns string) bool { return readable[ns] }
}

// usageByPods reads the containers' cores by the names of the node's pods, for a store whose series say nothing of the node.
func (n *NodeNeighbors) usageByPods(ctx context.Context, in *nodecpu.BusiestInput, budget *readBudget) (map[nodecpu.Key]nodecpu.Grid, error) {
	selector, left := nodecpu.PodSelector(in.Pods)
	if selector == "" {
		return nil, nil
	}
	got, err := n.series(ctx, budget, nodecpu.UsageQuery(in.Window, []string{selector}), in.Window)
	in.ByPods = true
	if err == nil && left > 0 {
		in.UsageWhy = fmt.Sprintf("the names of %d of the node's pods did not fit the query", left)
	}
	usage, _ := nodecpu.ByContainer(in.Window, got)
	return usage, err
}
