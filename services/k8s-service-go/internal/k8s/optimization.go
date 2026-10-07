package k8s

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// OptimizationRow is one container of one workload: what its pods ask for,
// what they used over the window, and the request that usage suggests
// (CPU = 95th percentile, memory = peak + 15%, as Robusta KRR's simple
// strategy sizes them). Requests and limits are 0 when unset.
type OptimizationRow struct {
	Kind              string   `json:"kind"`
	Namespace         string   `json:"namespace"`
	Name              string   `json:"name"`
	Container         string   `json:"container"`
	Pods              int      `json:"pods"`
	CPURequestM       int64    `json:"cpu_request_m"`
	CPULimitM         int64    `json:"cpu_limit_m"`
	CPUUsageM         *int64   `json:"cpu_usage_m,omitempty"`
	CPURecommendM     *int64   `json:"cpu_recommend_m,omitempty"`
	MemRequestBytes   int64    `json:"mem_request_bytes"`
	MemLimitBytes     int64    `json:"mem_limit_bytes"`
	MemUsageBytes     *int64   `json:"mem_usage_bytes,omitempty"`
	MemRecommendBytes *int64   `json:"mem_recommend_bytes,omitempty"`
	Flags             []string `json:"flags"`
}

// OptimizationResult: Source says where the usage came from — "prometheus"
// (percentile/peak over WindowHours), "metrics-server" (one instant sample)
// or "none".
type OptimizationResult struct {
	Namespace   string             `json:"namespace"`
	WindowHours int                `json:"window_hours"`
	Source      string             `json:"source"`
	GeneratedAt string             `json:"generated_at"`
	Rows        []OptimizationRow  `json:"rows"`
	Totals      OptimizationTotals `json:"totals"`
}

// OptimizationTotals sums requests and recommendations over all pods of the rows.
type OptimizationTotals struct {
	Pods              int   `json:"pods"`
	CPURequestM       int64 `json:"cpu_request_m"`
	CPURecommendM     int64 `json:"cpu_recommend_m"`
	MemRequestBytes   int64 `json:"mem_request_bytes"`
	MemRecommendBytes int64 `json:"mem_recommend_bytes"`
}

const (
	sourcePrometheus    = "prometheus"
	sourceMetricsServer = "metrics-server"
	sourceNone          = "none"

	cpuMinRecommendM     = 10
	memMinRecommendBytes = 100 << 20
	memHeadroom          = 1.15
)

type usageKey struct{ pod, container string }

type usageSample struct {
	cpuM     int64
	memBytes int64
	hasCPU   bool
	hasMem   bool
}

// CollectOptimization sizes the running pods of a namespace against their usage.
func (s *Service) CollectOptimization(ctx context.Context, namespace string, windowHours int) (*OptimizationResult, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, errNotLoaded
	}
	podList, err := cs.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}
	owner, err := s.workloadOwner(ctx, namespace)
	if err != nil {
		return nil, err
	}

	usage, source := map[usageKey]usageSample{}, sourceNone
	if s.PrometheusAvailable(ctx) {
		usage, err = s.prometheusUsage(ctx, namespace, windowHours)
		if err != nil {
			return nil, err
		}
		if len(usage) > 0 {
			source = sourcePrometheus
		}
	}
	if source == sourceNone {
		usage, err = s.metricsServerUsage(ctx, namespace)
		if err != nil {
			return nil, err
		}
		if len(usage) > 0 {
			source = sourceMetricsServer
		}
	}

	rows := optimizationRows(podList.Items, owner, usage)
	res := &OptimizationResult{Namespace: namespace, WindowHours: windowHours, Source: source, GeneratedAt: time.Now().UTC().Format(time.RFC3339), Rows: rows}
	for _, r := range rows {
		n := int64(r.Pods)
		res.Totals.Pods += r.Pods
		res.Totals.CPURequestM += r.CPURequestM * n
		res.Totals.MemRequestBytes += r.MemRequestBytes * n
		if r.CPURecommendM != nil {
			res.Totals.CPURecommendM += *r.CPURecommendM * n
		}
		if r.MemRecommendBytes != nil {
			res.Totals.MemRecommendBytes += *r.MemRecommendBytes * n
		}
	}
	return res, nil
}

// workloadOwner maps a pod to the workload it belongs to: ReplicaSets fold
// into their Deployment, Jobs into their CronJob, anything else keeps its
// controller; a bare pod and a static (Node-owned mirror) pod are their own "Pod".
func (s *Service) workloadOwner(ctx context.Context, namespace string) (func(corev1.Pod) (string, string), error) {
	cs := s.clientsetCtx(ctx)
	rsList, err := cs.AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list replicasets: %w", err)
	}
	jobList, err := cs.BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	parent := map[string][2]string{}
	for _, rs := range rsList.Items {
		if c := metav1.GetControllerOf(&rs); c != nil {
			parent["ReplicaSet/"+rs.Name] = [2]string{c.Kind, c.Name}
		}
	}
	for _, j := range jobList.Items {
		if c := metav1.GetControllerOf(&j); c != nil {
			parent["Job/"+j.Name] = [2]string{c.Kind, c.Name}
		}
	}
	return func(p corev1.Pod) (string, string) {
		c := metav1.GetControllerOf(&p)
		if c == nil || c.Kind == "Node" {
			return "Pod", p.Name
		}
		if up, ok := parent[c.Kind+"/"+c.Name]; ok {
			return up[0], up[1]
		}
		return c.Kind, c.Name
	}, nil
}

// optimizationRows groups the running pods' containers by workload and
// container name, keeps the largest request/limit seen and the heaviest
// usage sample across the pods, and flags and sizes each row.
func optimizationRows(pods []corev1.Pod, owner func(corev1.Pod) (string, string), usage map[usageKey]usageSample) []OptimizationRow {
	type acc struct {
		row  OptimizationRow
		pods map[string]bool
		use  usageSample
	}
	byKey := map[string]*acc{}
	var order []string
	for _, p := range pods {
		if p.Status.Phase != corev1.PodRunning {
			continue
		}
		kind, name := owner(p)
		for _, c := range p.Spec.Containers {
			key := kind + "/" + name + "/" + c.Name
			a, ok := byKey[key]
			if !ok {
				a = &acc{row: OptimizationRow{Kind: kind, Namespace: p.Namespace, Name: name, Container: c.Name}, pods: map[string]bool{}}
				byKey[key] = a
				order = append(order, key)
			}
			a.pods[p.Name] = true
			a.row.CPURequestM = maxInt64(a.row.CPURequestM, c.Resources.Requests.Cpu().MilliValue())
			a.row.CPULimitM = maxInt64(a.row.CPULimitM, c.Resources.Limits.Cpu().MilliValue())
			a.row.MemRequestBytes = maxInt64(a.row.MemRequestBytes, c.Resources.Requests.Memory().Value())
			a.row.MemLimitBytes = maxInt64(a.row.MemLimitBytes, c.Resources.Limits.Memory().Value())
			if u, ok := usage[usageKey{p.Name, c.Name}]; ok {
				if u.hasCPU && (!a.use.hasCPU || u.cpuM > a.use.cpuM) {
					a.use.cpuM, a.use.hasCPU = u.cpuM, true
				}
				if u.hasMem && (!a.use.hasMem || u.memBytes > a.use.memBytes) {
					a.use.memBytes, a.use.hasMem = u.memBytes, true
				}
			}
		}
	}
	rows := make([]OptimizationRow, 0, len(order))
	for _, key := range order {
		a := byKey[key]
		r := a.row
		r.Pods = len(a.pods)
		r.Flags = []string{}
		if r.CPURequestM == 0 {
			r.Flags = append(r.Flags, "no_cpu_request")
		}
		if r.MemRequestBytes == 0 {
			r.Flags = append(r.Flags, "no_mem_request")
		}
		if r.MemLimitBytes == 0 {
			r.Flags = append(r.Flags, "no_mem_limit")
		}
		if a.use.hasCPU {
			u, rec := a.use.cpuM, recommendCPU(a.use.cpuM)
			r.CPUUsageM, r.CPURecommendM = &u, &rec
			switch {
			case r.CPURequestM > 0 && u > r.CPURequestM:
				r.Flags = append(r.Flags, "cpu_under")
			case r.CPURequestM >= 2*rec && r.CPURequestM-rec >= 50:
				r.Flags = append(r.Flags, "cpu_over")
			}
		}
		if a.use.hasMem {
			u, rec := a.use.memBytes, recommendMem(a.use.memBytes)
			r.MemUsageBytes, r.MemRecommendBytes = &u, &rec
			switch {
			case r.MemRequestBytes > 0 && u > r.MemRequestBytes:
				r.Flags = append(r.Flags, "mem_under")
			case r.MemRequestBytes >= 2*rec && r.MemRequestBytes-rec >= 64<<20:
				r.Flags = append(r.Flags, "mem_over")
			}
		}
		rows = append(rows, r)
	}
	// Largest reclaimable CPU first, then memory, then name.
	waste := func(r OptimizationRow) (int64, int64) {
		var c, m int64
		if r.CPURecommendM != nil && r.CPURequestM > *r.CPURecommendM {
			c = (r.CPURequestM - *r.CPURecommendM) * int64(r.Pods)
		}
		if r.MemRecommendBytes != nil && r.MemRequestBytes > *r.MemRecommendBytes {
			m = (r.MemRequestBytes - *r.MemRecommendBytes) * int64(r.Pods)
		}
		return c, m
	}
	sort.SliceStable(rows, func(i, j int) bool {
		ci, mi := waste(rows[i])
		cj, mj := waste(rows[j])
		if ci != cj {
			return ci > cj
		}
		if mi != mj {
			return mi > mj
		}
		return rows[i].Kind+rows[i].Name+rows[i].Container < rows[j].Kind+rows[j].Name+rows[j].Container
	})
	return rows
}

// recommendCPU: the 95th-percentile millicores, rounded up to 5m, at least 10m.
func recommendCPU(p95M int64) int64 {
	rec := (p95M + 4) / 5 * 5
	if rec < cpuMinRecommendM {
		rec = cpuMinRecommendM
	}
	return rec
}

// recommendMem: peak + 15%, rounded up to 1Mi, at least 100Mi.
func recommendMem(peakBytes int64) int64 {
	rec := int64(math.Ceil(float64(peakBytes)*memHeadroom/float64(1<<20))) << 20
	if rec < memMinRecommendBytes {
		rec = memMinRecommendBytes
	}
	return rec
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// prometheusUsage reads cAdvisor series over the window: CPU p95 of the
// 5-minute rate, memory peak of the working set, per pod and container.
func (s *Service) prometheusUsage(ctx context.Context, namespace string, windowHours int) (map[usageKey]usageSample, error) {
	sel := fmt.Sprintf(`{namespace=%q, container!="", container!="POD"}`, namespace)
	cpuQ := fmt.Sprintf(`max by (pod, container) (quantile_over_time(0.95, rate(container_cpu_usage_seconds_total%s[5m])[%dh:1m]))`, sel, windowHours)
	memQ := fmt.Sprintf(`max by (pod, container) (max_over_time(container_memory_working_set_bytes%s[%dh]))`, sel, windowHours)
	out := map[usageKey]usageSample{}
	cpu, err := s.PrometheusQuery(ctx, cpuQ)
	if err != nil {
		return nil, fmt.Errorf("prometheus cpu usage: %w", err)
	}
	for _, r := range cpu {
		k := usageKey{fmt.Sprint(r.Metric["pod"]), fmt.Sprint(r.Metric["container"])}
		u := out[k]
		u.cpuM, u.hasCPU = int64(math.Ceil(r.Value*1000)), true
		out[k] = u
	}
	mem, err := s.PrometheusQuery(ctx, memQ)
	if err != nil {
		return nil, fmt.Errorf("prometheus memory usage: %w", err)
	}
	for _, r := range mem {
		k := usageKey{fmt.Sprint(r.Metric["pod"]), fmt.Sprint(r.Metric["container"])}
		u := out[k]
		u.memBytes, u.hasMem = int64(r.Value), true
		out[k] = u
	}
	return out, nil
}

// metricsServerUsage reads one instant sample per container from metrics.k8s.io.
func (s *Service) metricsServerUsage(ctx context.Context, namespace string) (map[usageKey]usageSample, error) {
	items, err := s.GetPodMetrics(ctx, namespace)
	if err != nil {
		if strings.Contains(err.Error(), "could not find the requested resource") {
			return map[usageKey]usageSample{}, nil
		}
		return nil, err
	}
	out := map[usageKey]usageSample{}
	for _, it := range items {
		pod := mapStr(it, "name")
		for _, c := range mapList(it, "containers") {
			out[usageKey{pod, mapStr(c, "name")}] = usageSample{
				cpuM: cpuToNanoCores(mapStr(c, "cpu")) / 1_000_000, memBytes: memoryToBytes(mapStr(c, "memory")), hasCPU: true, hasMem: true,
			}
		}
	}
	return out, nil
}
