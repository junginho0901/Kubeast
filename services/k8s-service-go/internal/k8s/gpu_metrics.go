package k8s

import (
	"context"
	"fmt"
	"sync"
)

// GetGPUMetrics returns real-time GPU metrics from DCGM Exporter via Prometheus.
// Returns {available: false} if Prometheus is unavailable, so callers can gracefully degrade.
func (s *Service) GetGPUMetrics(ctx context.Context) (map[string]interface{}, error) {
	if !s.PrometheusAvailable(ctx) {
		return map[string]interface{}{
			"available": false,
			"gpus":      []interface{}{},
		}, nil
	}

	// Query all DCGM metrics in parallel using the shared Prometheus client
	type queryResult struct {
		name    string
		results []PrometheusQueryResult
		err     error
	}

	queries := []struct {
		name  string
		query string
	}{
		{"gpu_util", "DCGM_FI_DEV_GPU_UTIL"},
		{"fb_used", "DCGM_FI_DEV_FB_USED"},
		{"fb_free", "DCGM_FI_DEV_FB_FREE"},
		{"mem_temp", "DCGM_FI_DEV_MEMORY_TEMP"},
	}

	results := make([]queryResult, len(queries))
	var wg sync.WaitGroup

	for i, q := range queries {
		wg.Add(1)
		go func(idx int, name, query string) {
			defer wg.Done()
			res, err := s.PrometheusQuery(ctx, query)
			results[idx] = queryResult{name: name, results: res, err: err}
		}(i, q.name, q.query)
	}
	wg.Wait()

	// Build per-GPU metrics map keyed by UUID. A value is nil while no series gave it: not read is not 0.
	type gpuMetric struct {
		UUID              string
		GPU               string
		Hostname          string
		ModelName         string
		GPUUtil           *float64
		MemoryUsedMB      *float64
		MemoryFreeMB      *float64
		MemoryTemp        *float64
		ExportedPod       string
		ExportedNamespace string
	}

	gpuMap := make(map[string]*gpuMetric)

	getOrCreate := func(r PrometheusQueryResult) *gpuMetric {
		m := r.Metric
		if m == nil {
			return nil
		}
		uuid := dcgmLabel(m, "UUID", "uuid")
		if uuid == "" {
			uuid = dcgmLabel(m, "hostname", "Hostname") + "/" + dcgmLabel(m, "device")
		}
		if g, ok := gpuMap[uuid]; ok {
			return g
		}
		g := &gpuMetric{UUID: uuid}
		g.GPU = dcgmLabel(m, "gpu")
		g.Hostname = dcgmLabel(m, "hostname", "Hostname")
		g.ModelName = dcgmLabel(m, "modelName")
		// the GPU's pod: exported_pod where the scrape renamed the exporter's pod label for its own target label
		// (honor_labels false), else pod (honor_labels true, or a target without one)
		g.ExportedPod = dcgmLabel(m, "exported_pod", "pod")
		g.ExportedNamespace = dcgmLabel(m, "exported_namespace", "namespace")
		gpuMap[uuid] = g
		return g
	}

	// a query that failed (the store refused the caller, timed out) is the answer: zeros would read as "no GPUs"
	for _, qr := range results {
		if qr.err != nil {
			return nil, fmt.Errorf("GPU metric %s: %w", qr.name, qr.err)
		}
	}
	for _, qr := range results {
		for _, r := range qr.results {
			g := getOrCreate(r)
			if g == nil {
				continue
			}
			value := r.Value
			switch qr.name {
			case "gpu_util":
				g.GPUUtil = &value
			case "fb_used":
				g.MemoryUsedMB = &value
			case "fb_free":
				g.MemoryFreeMB = &value
			case "mem_temp":
				g.MemoryTemp = &value
			}
		}
	}

	// Calculate totals and build response: each is of the GPUs that have the value, as PromQL's avg() and a division of
	// two series are, and null with none. A GPU's memory takes both its series; one alone would read as 0 % or 100 %.
	gpus := make([]map[string]interface{}, 0, len(gpuMap))
	var totalUtil, totalMemUsed, totalMemFree float64
	utilCount, memCount := 0, 0

	for _, key := range sortedKeys(gpuMap) {
		g := gpuMap[key]
		var memTotal, memPercent interface{}
		if g.MemoryUsedMB != nil && g.MemoryFreeMB != nil {
			total := *g.MemoryUsedMB + *g.MemoryFreeMB
			memTotal = total
			if total > 0 {
				memPercent = (*g.MemoryUsedMB / total) * 100
			}
			totalMemUsed += *g.MemoryUsedMB
			totalMemFree += *g.MemoryFreeMB
			memCount++
		}
		if g.GPUUtil != nil {
			totalUtil += *g.GPUUtil
			utilCount++
		}

		gpus = append(gpus, map[string]interface{}{
			"uuid":                g.UUID,
			"gpu":                 g.GPU,
			"hostname":            g.Hostname,
			"model_name":          g.ModelName,
			"gpu_util":            numberOrNull(g.GPUUtil),
			"memory_used_mb":      numberOrNull(g.MemoryUsedMB),
			"memory_free_mb":      numberOrNull(g.MemoryFreeMB),
			"memory_total_mb":     memTotal,
			"memory_util_percent": memPercent,
			"memory_temp":         numberOrNull(g.MemoryTemp),
			"exported_pod":        g.ExportedPod,
			"exported_namespace":  g.ExportedNamespace,
		})
	}

	var avgUtil, avgMemUtil, memUsed, memFree, memTotal interface{}
	if utilCount > 0 {
		avgUtil = totalUtil / float64(utilCount)
	}
	if memCount > 0 {
		memUsed, memFree, memTotal = totalMemUsed, totalMemFree, totalMemUsed+totalMemFree
		if total := totalMemUsed + totalMemFree; total > 0 {
			avgMemUtil = (totalMemUsed / total) * 100
		}
	}

	return map[string]interface{}{
		"available":            true,
		"gpu_count":            len(gpus),
		"avg_gpu_util":         avgUtil,
		"avg_memory_util":      avgMemUtil,
		"total_memory_used_mb": memUsed,
		"total_memory_free_mb": memFree,
		"total_memory_mb":      memTotal,
		"gpus":                 gpus,
	}, nil
}

// numberOrNull is a value a series gave, or nil for JSON's null.
func numberOrNull(v *float64) interface{} {
	if v == nil {
		return nil
	}
	return *v
}

// dcgmLabel is the first of names a DCGM series carries: dcgm-exporter writes UUID (uuid with
// --use-old-namespace) and, since 4.6.0, hostname where it wrote Hostname.
func dcgmLabel(m map[string]interface{}, names ...string) string {
	for _, n := range names {
		if v, _ := m[n].(string); v != "" {
			return v
		}
	}
	return ""
}

// placeholder to keep fmt imported (used in prometheus.go via Sscanf)
var _ = fmt.Sprintf
