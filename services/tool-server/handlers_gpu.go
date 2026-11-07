// The GPU screens' numbers as a tool: the answers of the APIs those screens read, as the caller, and what the screens
// count from them (frontend pages/gpu/gpuNumbers.ts). A source the caller may not read or that failed is named and its
// numbers are null, not zero, as a screen's card shows "-".

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// notInstalledHeader names, on an empty list, a kind the cluster does not serve (k8s-service handler/served.go).
const notInstalledHeader = "X-Kubeast-Not-Installed"

// The companies in the screens' order (k8s-service gpu_dashboard.go gpuVendors).
var gpuVendorNames = []string{"NVIDIA", "AMD", "Intel"}

type gpuRead struct {
	status int
	header http.Header
	body   []byte
	err    error
}

func gpuInt(m map[string]interface{}, key string) int {
	v, _ := m[key].(float64)
	return int(v)
}

func gpuString(m map[string]interface{}, key string) string {
	v, _ := m[key].(string)
	return v
}

func gpuRows(v interface{}) []map[string]interface{} {
	list, _ := v.([]interface{})
	out := make([]map[string]interface{}, 0, len(list))
	for _, item := range list {
		if m, ok := item.(map[string]interface{}); ok {
			out = append(out, m)
		}
	}
	return out
}

// gpuPercent is a screen's Math.round(used / allocatable * 100), 0 with nothing allocatable.
func gpuPercent(used, allocatable int) int {
	if allocatable <= 0 {
		return 0
	}
	return int(math.Round(float64(used) / float64(allocatable) * 100))
}

// gpuStatusNamesError is gpuNumbers.ts statusNamesError, the Pods list's Error card.
func gpuStatusNamesError(status string) bool {
	s := strings.ToLower(status)
	for _, word := range []string{"error", "failed", "backoff", "errimagepull", "oomkilled"} {
		if strings.Contains(s, word) {
			return true
		}
	}
	return false
}

func gpuPodEnded(pod map[string]interface{}) bool {
	phase := gpuString(pod, "phase")
	return phase == "Succeeded" || phase == "Failed"
}

// gpuSortDesc orders rows by a number, the highest first, keeping the server's order among equals.
func gpuSortDesc(v interface{}, key string) {
	list, _ := v.([]interface{})
	value := func(i int) int {
		m, _ := list[i].(map[string]interface{})
		return gpuInt(m, key)
	}
	sort.SliceStable(list, func(i, j int) bool { return value(i) > value(j) })
}

// gpuDashboardNumbers puts the dashboard's answer and the screens' counts of it into result. Free is what each node's
// company has left: another company's GPUs on the node do not fill for it, and a pod held on a node that no longer
// advertises its GPUs leaves nothing.
func gpuDashboardNumbers(result, d map[string]interface{}) {
	for _, key := range []string{"total_gpu_capacity", "total_gpu_allocatable", "total_gpu_used", "total_gpu_waiting", "mig_enabled", "time_slicing_enabled", "time_slicing_config", "dra_pods"} {
		result[key] = d[key]
	}

	type modelCount struct {
		name                               string
		nodes, capacity, allocatable, used int
	}
	var models []*modelCount
	modelOf := map[string]*modelCount{}
	freeOf, nodesOf := map[string]int{}, map[string]int{}
	totalFree, ready := 0, 0
	nodes := gpuRows(d["gpu_nodes"])
	for _, node := range nodes {
		nodeFree := 0
		for _, v := range gpuRows(node["gpu_vendors"]) {
			vendor := gpuString(v, "vendor")
			left := max(0, gpuInt(v, "allocatable")-gpuInt(v, "used"))
			nodeFree += left
			freeOf[vendor] += left
			nodesOf[vendor]++
			name := gpuString(v, "model")
			if name == "" {
				name = "Unknown"
			}
			m := modelOf[name]
			if m == nil {
				m = &modelCount{name: name}
				modelOf[name] = m
				models = append(models, m)
			}
			m.nodes++
			m.capacity += gpuInt(v, "capacity")
			m.allocatable += gpuInt(v, "allocatable")
			m.used += gpuInt(v, "used")
		}
		totalFree += nodeFree
		node["gpu_free"] = nodeFree
		node["used_percent"] = gpuPercent(gpuInt(node, "gpu_used"), gpuInt(node, "gpu_allocatable"))
		// kubectl's STATUS starts with Ready for a cordoned node too (Ready,SchedulingDisabled)
		if strings.TrimSpace(strings.Split(gpuString(node, "status"), ",")[0]) == "Ready" {
			ready++
		}
	}
	result["total_gpu_free"] = totalFree
	result["allocation_rate"] = gpuPercent(gpuInt(d, "total_gpu_used"), gpuInt(d, "total_gpu_allocatable"))
	result["node_counts"] = map[string]interface{}{"total": len(nodes), "ready": ready, "not_ready": len(nodes) - ready}

	vendors := gpuRows(d["vendors"])
	for _, v := range vendors {
		v["free"] = freeOf[gpuString(v, "vendor")]
		v["nodes"] = nodesOf[gpuString(v, "vendor")]
	}
	result["vendors"] = vendors

	sort.SliceStable(models, func(i, j int) bool { return models[i].capacity > models[j].capacity })
	modelRows := make([]map[string]interface{}, 0, len(models))
	for _, m := range models {
		modelRows = append(modelRows, map[string]interface{}{"model": m.name, "nodes": m.nodes, "capacity": m.capacity, "allocatable": m.allocatable, "used": m.used})
	}
	result["models"] = modelRows

	plugins := gpuRows(d["device_plugins"])
	for _, p := range plugins {
		switch found, _ := p["found"].(bool); {
		case !found:
			p["state"] = "missing"
		case gpuInt(p, "ready") >= gpuInt(p, "desired"):
			p["state"] = "healthy"
		default:
			p["state"] = "unhealthy"
		}
	}
	result["device_plugins"] = plugins

	pods := gpuRows(d["gpu_pods"])
	running, pending, failed, requested := 0, 0, 0, 0
	namespaces := map[string]bool{}
	podsOf, askedOf := map[string]int{}, map[string]int{}
	for _, pod := range pods {
		phase := gpuString(pod, "phase")
		// a pod in one card, as gpuNumbers.ts gpuPodCounts
		switch {
		case phase == "Failed" || gpuStatusNamesError(gpuString(pod, "status")):
			failed++
		case phase == "Running":
			running++
		case phase == "Pending":
			pending++
		}
		if !gpuPodEnded(pod) {
			requested += gpuInt(pod, "gpu_requested")
		}
		namespaces[gpuString(pod, "namespace")] = true
		for _, v := range gpuRows(pod["gpu_vendors"]) {
			vendor := gpuString(v, "vendor")
			podsOf[vendor]++
			if !gpuPodEnded(pod) {
				askedOf[vendor] += gpuInt(v, "requested")
			}
		}
	}
	result["pod_counts"] = map[string]interface{}{"total": len(pods), "running": running, "pending": pending, "failed": failed, "requested": requested, "namespaces": len(namespaces)}
	podVendors := make([]map[string]interface{}, 0, len(gpuVendorNames))
	for _, vendor := range gpuVendorNames {
		if podsOf[vendor] > 0 {
			podVendors = append(podVendors, map[string]interface{}{"vendor": vendor, "pods": podsOf[vendor], "requested": askedOf[vendor]})
		}
	}
	result["pod_vendors"] = podVendors

	// most first, as the screens draw them: what a cut drops is the least of it
	gpuSortDesc(d["gpu_nodes"], "gpu_capacity")
	gpuSortDesc(d["gpu_pods"], "gpu_requested")
	result["gpu_nodes"] = d["gpu_nodes"]
	result["gpu_pods"] = d["gpu_pods"]

	if gpuInt(d, "total_gpu_capacity") == 0 && len(pods) == 0 {
		result["hint"] = "No GPU resources detected in this cluster: no node advertises a GPU (NVIDIA, AMD or Intel device plugin) and no pod asks for one."
	}
}

// gpuHolders are the pods a GPU's DCGM series may name (gpuNumbers.ts gpuHolderPods): those asking for GPUs and those
// an allocated DRA claim is reserved for. An exporter scraped as its own pod labels an idle GPU's series with that pod.
func gpuHolders(d map[string]interface{}) map[string]bool {
	holders := map[string]bool{}
	for _, list := range []interface{}{d["gpu_pods"], d["dra_pods"]} {
		for _, pod := range gpuRows(list) {
			holders[gpuString(pod, "namespace")+"/"+gpuString(pod, "name")] = true
		}
	}
	return holders
}

// gpuUtilization is the screens' real-time numbers. No Prometheus, no DCGM series or no memory series is not 0%.
func gpuUtilization(metrics map[string]interface{}, read bool) map[string]interface{} {
	u := map[string]interface{}{"available": nil, "gpu_count": nil, "avg_gpu_util": nil, "avg_memory_util": nil,
		"total_memory_used_mb": nil, "total_memory_free_mb": nil, "total_memory_mb": nil}
	if !read {
		return u
	}
	available, _ := metrics["available"].(bool)
	u["available"] = available
	if !available {
		u["note"] = "This cluster has no Prometheus Kubeast can read, so utilization is not counted, not zero."
		return u
	}
	count := gpuInt(metrics, "gpu_count")
	u["gpu_count"] = count
	if count == 0 {
		u["note"] = "The cluster's Prometheus has no DCGM series (no dcgm-exporter scraped), so utilization is not counted, not zero."
		return u
	}
	u["avg_gpu_util"] = metrics["avg_gpu_util"]
	if gpuInt(metrics, "total_memory_mb") > 0 {
		for _, key := range []string{"avg_memory_util", "total_memory_used_mb", "total_memory_free_mb", "total_memory_mb"} {
			u[key] = metrics[key]
		}
	}
	if note := gpuUnreadNote(gpuRows(metrics["gpus"])); note != "" {
		u["note"] = note
	}
	return u
}

// gpuUnreadNote says what the averages leave out, as the screens' cards do: a GPU missing a series is not counted, not
// counted as zero. Empty when every GPU reports.
func gpuUnreadNote(rows []map[string]interface{}) string {
	noUtil, noMemory := 0, 0
	for _, g := range rows {
		if g["gpu_util"] == nil {
			noUtil++
		}
		if g["memory_total_mb"] == nil {
			noMemory++
		}
	}
	notes := []string{}
	switch {
	case noUtil == 0:
	case noUtil == len(rows):
		notes = append(notes, "No GPU reports a utilization series, so it is not counted, not zero.")
	default:
		notes = append(notes, fmt.Sprintf("%d of the %d GPUs report no utilization series: avg_gpu_util is the average of the others, and their gpu_util is null, not zero.", noUtil, len(rows)))
	}
	switch {
	case noMemory == 0:
	case noMemory == len(rows):
		notes = append(notes, "No GPU reports both memory series, so memory is not counted, not zero.")
	default:
		notes = append(notes, fmt.Sprintf("%d of the %d GPUs do not report both memory series: the memory numbers are of the others.", noMemory, len(rows)))
	}
	return strings.Join(notes, " ")
}

// gpuSeriesRows are the GPUs of the real-time answer with the pod the screens name, and adds each pod's use to its row
// (gpuNumbers.ts podGpuUsage: the mean of its GPUs that report, the used of the total memory of those that report both).
func gpuSeriesRows(metrics, dashboard map[string]interface{}) []map[string]interface{} {
	holders := gpuHolders(dashboard)
	type usage struct {
		n, reporting      int
		util, used, total float64
	}
	byPod := map[string]*usage{}
	rows := []map[string]interface{}{}
	for _, g := range gpuRows(metrics["gpus"]) {
		row := map[string]interface{}{}
		for _, key := range []string{"uuid", "gpu", "hostname", "model_name", "gpu_util", "memory_used_mb", "memory_free_mb", "memory_total_mb", "memory_util_percent", "memory_temp"} {
			row[key] = g[key]
		}
		total, _ := g["memory_total_mb"].(float64)
		if total == 0 {
			// 0 of 0 reads as nothing, and what a GPU with one memory series reports stays
			for _, key := range []string{"memory_used_mb", "memory_free_mb", "memory_total_mb", "memory_util_percent"} {
				if value, _ := g[key].(float64); value == 0 {
					row[key] = nil
				}
			}
		}
		// the screens leave a temperature of 0 out: it is a series that is not there
		if temp, _ := g["memory_temp"].(float64); temp == 0 {
			row["memory_temp"] = nil
		}
		namespace, pod := gpuString(g, "exported_namespace"), gpuString(g, "exported_pod")
		key := namespace + "/" + pod
		if pod != "" && holders[key] {
			row["pod"] = key
		}
		if pod != "" && namespace != "" {
			u := byPod[key]
			if u == nil {
				u = &usage{}
				byPod[key] = u
			}
			u.n++
			if util, reports := g["gpu_util"].(float64); reports {
				u.reporting++
				u.util += util
			}
			if total > 0 {
				used, _ := g["memory_used_mb"].(float64)
				u.used += used
				u.total += total
			}
		}
		rows = append(rows, row)
	}
	for _, pod := range gpuRows(dashboard["gpu_pods"]) {
		u := byPod[gpuString(pod, "namespace")+"/"+gpuString(pod, "name")]
		if u == nil {
			continue
		}
		var util, memory interface{}
		if u.reporting > 0 {
			util = u.util / float64(u.reporting)
		}
		if u.total > 0 {
			memory = u.used / u.total * 100
		}
		pod["gpu_usage"] = map[string]interface{}{"gpus": u.n, "gpu_util": util, "memory_util_percent": memory}
	}
	return rows
}

// handleGPU answers the GPU and DRA summary the GPU screens show.
func handleGPU(ctx context.Context, _ map[string]interface{}, headers http.Header) (string, error) {
	const dashboardPart, metricsPart, classesPart, templatesPart = "dashboard", "metrics", "device_classes", "resource_claim_templates"
	paths := map[string]string{
		dashboardPart: "/gpu/dashboard",
		metricsPart:   "/gpu/metrics",
		classesPart:   "/deviceclasses",
		templatesPart: "/resourceclaimtemplates/all",
	}
	reads := map[string]*gpuRead{}
	var wg sync.WaitGroup
	for part, path := range paths {
		r := &gpuRead{}
		reads[part] = r
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.status, r.header, r.body, r.err = k8sServiceGetWithHeader(ctx, headers, path, nil)
		}()
	}
	wg.Wait()

	refused, notRead := map[string]interface{}{}, map[string]interface{}{}
	notServed := []string{}
	// ok is an answer the numbers can come from; anything else is named and its numbers stay null
	ok := func(part string) bool {
		r := reads[part]
		switch {
		case r.err != nil:
			notRead[part] = r.err.Error()
		case r.status == http.StatusOK:
			return true
		case r.status == http.StatusForbidden:
			refused[part] = detailOf(r.body)
		default:
			notRead[part] = fmt.Sprintf("status %d: %s", r.status, detailOf(r.body))
		}
		return false
	}
	decode := func(part string, into interface{}) error {
		if err := json.Unmarshal(reads[part].body, into); err != nil {
			return fmt.Errorf("gpu: unreadable %s reply: %w", part, err)
		}
		return nil
	}

	// The dashboard is what the tool is for: a failure there is the tool's, a refusal the same as any other part's.
	dash := reads[dashboardPart]
	if dash.err != nil {
		return "", dash.err
	}
	if dash.status != http.StatusOK && dash.status != http.StatusForbidden {
		out, answered, err := featureFailure("gpu", "", dash.status, dash.body)
		if answered {
			return out, nil
		}
		return "", err
	}

	result := map[string]interface{}{}
	for _, key := range []string{"total_gpu_capacity", "total_gpu_allocatable", "total_gpu_used", "total_gpu_free", "total_gpu_waiting", "allocation_rate",
		"vendors", "node_counts", "pod_counts", "pod_vendors", "models", "device_plugins", "mig_enabled", "time_slicing_enabled", "time_slicing_config",
		"gpu_nodes", "gpu_pods", "dra_pods", "gpus", "device_classes", "resource_claim_templates"} {
		result[key] = nil
	}
	dashboard := map[string]interface{}{}
	if ok(dashboardPart) {
		if err := decode(dashboardPart, &dashboard); err != nil {
			return "", err
		}
		gpuDashboardNumbers(result, dashboard)
	}

	metrics := map[string]interface{}{}
	metricsRead := ok(metricsPart)
	if metricsRead {
		if err := decode(metricsPart, &metrics); err != nil {
			return "", err
		}
	}
	result["utilization"] = gpuUtilization(metrics, metricsRead)
	if available, _ := metrics["available"].(bool); available {
		result["gpus"] = gpuSeriesRows(metrics, dashboard)
	}

	for _, part := range []string{classesPart, templatesPart} {
		if !ok(part) {
			continue
		}
		if reads[part].header.Get(notInstalledHeader) != "" {
			notServed = append(notServed, part)
			continue
		}
		rows := []interface{}{}
		if err := decode(part, &rows); err != nil {
			return "", err
		}
		if rows == nil {
			rows = []interface{}{}
		}
		result[part] = rows
	}

	if len(refused) > 0 {
		result["refused"] = refused
	}
	if len(notRead) > 0 {
		result["not_read"] = notRead
	}
	if len(notServed) > 0 {
		result["not_served"] = notServed
	}
	if len(refused)+len(notRead)+len(notServed) > 0 {
		result["null_note"] = "A number or list whose source is named in refused, not_read or not_served is null: it is not counted, not zero."
	}
	gpuCapRows(result)
	return marshalOrdered(result,
		[]string{"refused", "not_read", "not_served", "null_note", "hint", "truncated",
			"total_gpu_capacity", "total_gpu_allocatable", "total_gpu_used", "total_gpu_free", "total_gpu_waiting", "allocation_rate",
			"vendors", "node_counts", "pod_counts", "pod_vendors", "models", "device_plugins", "mig_enabled", "time_slicing_enabled", "time_slicing_config", "utilization"},
		[]string{"device_classes_total", "device_classes", "resource_claim_templates_total", "resource_claim_templates",
			"gpu_nodes_total", "gpu_nodes", "gpu_pods_total", "gpu_pods", "dra_pods_total", "dra_pods", "gpus_total", "gpus"})
}

// gpuCapRows cuts each list at rowsCap and says so; the counts above were made before it.
func gpuCapRows(result map[string]interface{}) {
	for _, key := range []string{"device_classes", "resource_claim_templates", "gpu_nodes", "gpu_pods", "dra_pods", "gpus"} {
		switch rows := result[key].(type) {
		case []map[string]interface{}:
			list := make([]interface{}, len(rows))
			for i, row := range rows {
				list[i] = row
			}
			result[key] = list
		case nil:
			continue
		}
		capList(result, key, rowsCap)
	}
}
