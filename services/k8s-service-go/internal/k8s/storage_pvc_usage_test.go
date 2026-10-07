package k8s

import "testing"

func pvcSeries(ns, name string, v float64) PrometheusQueryResult {
	return PrometheusQueryResult{Metric: map[string]interface{}{"namespace": ns, "persistentvolumeclaim": name}, Value: v}
}

func TestPVCUsageFromSeries(t *testing.T) {
	used := []PrometheusQueryResult{pvcSeries("a", "data", 850<<20), pvcSeries("a", "nocap", 1), pvcSeries("b", "logs", 100<<20)}
	capacity := []PrometheusQueryResult{pvcSeries("a", "data", 1000<<20), pvcSeries("b", "logs", 1000<<20), pvcSeries("c", "orphan", 5)}
	// a/data loses 10 MiB/h, b/logs grows free space.
	trend := []PrometheusQueryResult{pvcSeries("a", "data", -float64(10<<20)/3600), pvcSeries("b", "logs", 1)}
	got := pvcUsageFromSeries(used, capacity, trend)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	d := got["a/data"]
	if d.Percent != 85 || d.CapacityBytes != 1000<<20 || d.Source != "prometheus" || d.FillsInDays == nil || *d.FillsInDays != 0.6 {
		t.Errorf("a/data: %+v fills=%v", d, d.FillsInDays)
	}
	l := got["b/logs"]
	if l.Percent != 10 || l.FillsInDays != nil {
		t.Errorf("b/logs: %+v", l)
	}

	items := []map[string]interface{}{{"namespace": "a", "name": "data"}, {"namespace": "a", "name": "other"}}
	attachPVCUsage(items, got)
	if _, ok := items[0]["usage"].(PVCUsage); !ok {
		t.Errorf("usage not attached: %+v", items[0])
	}
	if v, ok := items[1]["usage"]; !ok || v != nil {
		t.Errorf("unknown claim should carry usage: null, got %+v", items[1])
	}
}
