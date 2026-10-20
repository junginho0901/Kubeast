package cluster

import (
	"strings"
	"testing"
)

func TestParsePrometheusService(t *testing.T) {
	ns, name, port, path, err := ParsePrometheusService("monitoring/kube-prometheus-stack-prometheus:9090")
	if err != nil || ns != "monitoring" || name != "kube-prometheus-stack-prometheus" || port != 9090 || path != "" {
		t.Fatalf("got %q %q %d %q %v", ns, name, port, path, err)
	}
	if _, _, port, _, err := ParsePrometheusService("o11y/prometheus-server:80"); err != nil || port != 80 {
		t.Fatalf("port 80: %d %v", port, err)
	}
	// a VictoriaMetrics cluster reads under /select/<tenant>/prometheus
	if _, name, port, path, err := ParsePrometheusService("monitoring/vmselect-main:8481/select/0/prometheus"); err != nil || name != "vmselect-main" || port != 8481 || path != "/select/0/prometheus" {
		t.Fatalf("vmselect: %q %d %q %v", name, port, path, err)
	}
	// the path is at most 200 characters
	if _, _, _, path, err := ParsePrometheusService("monitoring/vmselect-main:8481/" + strings.Repeat("a", 199)); err != nil || len(path) != 200 {
		t.Fatalf("200: %d %v", len(path), err)
	}
	for _, bad := range []string{
		"monitoring/vmselect-main:8481/" + strings.Repeat("a", 200),
		"", "monitoring/prometheus", "prometheus:9090", "monitoring/prometheus:0", "monitoring/prometheus:65536",
		"Monitoring/prometheus:9090", "monitoring/../x:9090", "-ns/prometheus:9090",
		"monitoring/prometheus:90a", "http://monitoring/prometheus:9090", "monitoring/prom etheus:9090",
		"monitoring/prometheus:9090/", "monitoring/prometheus:9090/a/../b", "monitoring/prometheus:9090/./a",
		"monitoring/prometheus:9090/api?x=1", "monitoring/prometheus:9090/a b", "monitoring/prometheus:9090//a",
		"monitoring/prometheus:9090/%2e%2e",
	} {
		if _, _, _, _, err := ParsePrometheusService(bad); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}
