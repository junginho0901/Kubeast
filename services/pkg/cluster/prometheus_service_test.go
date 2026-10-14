package cluster

import "testing"

func TestParsePrometheusService(t *testing.T) {
	ns, name, port, err := ParsePrometheusService("monitoring/kube-prometheus-stack-prometheus:9090")
	if err != nil || ns != "monitoring" || name != "kube-prometheus-stack-prometheus" || port != 9090 {
		t.Fatalf("got %q %q %d %v", ns, name, port, err)
	}
	if _, _, port, err := ParsePrometheusService("o11y/prometheus-server:80"); err != nil || port != 80 {
		t.Fatalf("port 80: %d %v", port, err)
	}
	for _, bad := range []string{
		"", "monitoring/prometheus", "prometheus:9090", "monitoring/prometheus:0", "monitoring/prometheus:65536",
		"Monitoring/prometheus:9090", "monitoring/prometheus:9090/api", "monitoring/../x:9090", "-ns/prometheus:9090",
		"monitoring/prometheus:90a", "http://monitoring/prometheus:9090", "monitoring/prom etheus:9090",
	} {
		if _, _, _, err := ParsePrometheusService(bad); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}
