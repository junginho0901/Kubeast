package k8s

import (
	"context"
	"fmt"
	"math"
	"time"
)

// PVCUsage is the kubelet's view of a mounted volume, read from Prometheus
// (kubelet_volume_stats_*): how full it is and, from the 6-hour trend, in
// how many days it fills up. Absent when the CSI driver reports no volume
// stats or Prometheus does not scrape the kubelet.
type PVCUsage struct {
	UsedBytes     int64    `json:"used_bytes"`
	CapacityBytes int64    `json:"capacity_bytes"`
	Percent       float64  `json:"percent"`
	FillsInDays   *float64 `json:"fills_in_days,omitempty"`
	Source        string   `json:"source"`
}

// GetAllPVCsWithUsage is GetAllPVCs with a "usage" field on every claim
// (null when unknown).
func (s *Service) GetAllPVCsWithUsage(ctx context.Context) ([]map[string]interface{}, error) {
	items, err := s.GetAllPVCs(ctx)
	if err != nil {
		return nil, err
	}
	attachPVCUsage(items, s.pvcUsage(ctx))
	return items, nil
}

// GetPVCsWithUsage is GetPVCs with a "usage" field on every claim.
func (s *Service) GetPVCsWithUsage(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	items, err := s.GetPVCs(ctx, namespace)
	if err != nil {
		return nil, err
	}
	attachPVCUsage(items, s.pvcUsage(ctx))
	return items, nil
}

// pvcUsage returns the usage of every claim Prometheus knows, keyed
// "namespace/name"; nil when Prometheus is off, unreachable or has no stats.
func (s *Service) pvcUsage(ctx context.Context) map[string]PVCUsage {
	if !s.PrometheusAvailable(ctx) {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	used, err := s.PrometheusQuery(ctx, `max by (namespace, persistentvolumeclaim) (kubelet_volume_stats_used_bytes)`)
	if err != nil || len(used) == 0 {
		return nil
	}
	capacity, err := s.PrometheusQuery(ctx, `max by (namespace, persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes)`)
	if err != nil {
		return nil
	}
	trend, _ := s.PrometheusQuery(ctx, `max by (namespace, persistentvolumeclaim) (deriv(kubelet_volume_stats_available_bytes[6h]))`)
	return pvcUsageFromSeries(used, capacity, trend)
}

func pvcUsageFromSeries(used, capacity, trend []PrometheusQueryResult) map[string]PVCUsage {
	key := func(r PrometheusQueryResult) string {
		return fmt.Sprint(r.Metric["namespace"]) + "/" + fmt.Sprint(r.Metric["persistentvolumeclaim"])
	}
	out := map[string]PVCUsage{}
	for _, r := range used {
		out[key(r)] = PVCUsage{UsedBytes: int64(r.Value), Source: sourcePrometheus}
	}
	for _, r := range capacity {
		u, ok := out[key(r)]
		if !ok || r.Value <= 0 {
			continue
		}
		u.CapacityBytes = int64(r.Value)
		u.Percent = math.Round(float64(u.UsedBytes)/r.Value*1000) / 10
		out[key(r)] = u
	}
	for _, r := range trend {
		u, ok := out[key(r)]
		if !ok || u.CapacityBytes == 0 || r.Value >= 0 {
			continue
		}
		days := math.Round(float64(u.CapacityBytes-u.UsedBytes)/-r.Value/86400*10) / 10
		u.FillsInDays = &days
		out[key(r)] = u
	}
	for k, u := range out {
		if u.CapacityBytes == 0 {
			delete(out, k)
		}
	}
	return out
}

func attachPVCUsage(items []map[string]interface{}, usage map[string]PVCUsage) {
	for _, it := range items {
		if u, ok := usage[mapStr(it, "namespace")+"/"+mapStr(it, "name")]; ok {
			it["usage"] = u
		} else {
			it["usage"] = nil
		}
	}
}
