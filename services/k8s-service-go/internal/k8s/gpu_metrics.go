package k8s

import (
	"context"
	"fmt"
	"log/slog"
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

	// Build per-GPU metrics map keyed by UUID
	type gpuMetric struct {
		UUID              string
		GPU               string
		Hostname          string
		ModelName         string
		GPUUtil           float64
		MemoryUsedMB      float64
		MemoryFreeMB      float64
		MemoryTotalMB     float64
		MemoryUtilPercent float64
		MemoryTemp        float64
		ExportedPod       string
		ExportedNamespace string
	}

	gpuMap := make(map[string]*gpuMetric)

	getOrCreate := func(r PrometheusQueryResult) *gpuMetric {
		m := r.Metric
		if m == nil {
			return nil
		}
		uuid, _ := m["UUID"].(string)
		if uuid == "" {
			device, _ := m["device"].(string)
			hostname, _ := m["Hostname"].(string)
			uuid = hostname + "/" + device
		}
		if g, ok := gpuMap[uuid]; ok {
			return g
		}
		g := &gpuMetric{UUID: uuid}
		if v, ok := m["gpu"].(string); ok {
			g.GPU = v
		}
		if v, ok := m["Hostname"].(string); ok {
			g.Hostname = v
		}
		if v, ok := m["modelName"].(string); ok {
			g.ModelName = v
		}
		if v, ok := m["exported_pod"].(string); ok {
			g.ExportedPod = v
		}
		if v, ok := m["exported_namespace"].(string); ok {
			g.ExportedNamespace = v
		}
		gpuMap[uuid] = g
		return g
	}

	for _, qr := range results {
		if qr.err != nil {
			slog.Debug("GPU metric query failed", "metric", qr.name, "err", qr.err)
			continue
		}
		for _, r := range qr.results {
			g := getOrCreate(r)
			if g == nil {
				continue
			}
			switch qr.name {
			case "gpu_util":
				g.GPUUtil = r.Value
			case "fb_used":
				g.MemoryUsedMB = r.Value
			case "fb_free":
				g.MemoryFreeMB = r.Value
			case "mem_temp":
				g.MemoryTemp = r.Value
			}
		}
	}

	// Calculate totals and build response
	gpus := make([]map[string]interface{}, 0, len(gpuMap))
	var totalUtil, totalMemUsed, totalMemFree float64
	count := 0

	for _, g := range gpuMap {
		g.MemoryTotalMB = g.MemoryUsedMB + g.MemoryFreeMB
		if g.MemoryTotalMB > 0 {
			g.MemoryUtilPercent = (g.MemoryUsedMB / g.MemoryTotalMB) * 100
		}

		totalUtil += g.GPUUtil
		totalMemUsed += g.MemoryUsedMB
		totalMemFree += g.MemoryFreeMB
		count++

		gpus = append(gpus, map[string]interface{}{
			"uuid":                g.UUID,
			"gpu":                 g.GPU,
			"hostname":            g.Hostname,
			"model_name":          g.ModelName,
			"gpu_util":            g.GPUUtil,
			"memory_used_mb":      g.MemoryUsedMB,
			"memory_free_mb":      g.MemoryFreeMB,
			"memory_total_mb":     g.MemoryTotalMB,
			"memory_util_percent": g.MemoryUtilPercent,
			"memory_temp":         g.MemoryTemp,
			"exported_pod":        g.ExportedPod,
			"exported_namespace":  g.ExportedNamespace,
		})
	}

	avgUtil := float64(0)
	avgMemUtil := float64(0)
	totalMem := totalMemUsed + totalMemFree
	if count > 0 {
		avgUtil = totalUtil / float64(count)
	}
	if totalMem > 0 {
		avgMemUtil = (totalMemUsed / totalMem) * 100
	}

	return map[string]interface{}{
		"available":            true,
		"gpu_count":            count,
		"avg_gpu_util":         avgUtil,
		"avg_memory_util":      avgMemUtil,
		"total_memory_used_mb": totalMemUsed,
		"total_memory_free_mb": totalMemFree,
		"total_memory_mb":      totalMem,
		"gpus":                 gpus,
	}, nil
}

// placeholder to keep fmt imported (used in prometheus.go via Sscanf)
var _ = fmt.Sprintf
