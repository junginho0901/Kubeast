package cluster

import (
	"fmt"
	"regexp"
	"strconv"
)

var promServiceRef = regexp.MustCompile(`^([a-z0-9]([-a-z0-9]*[a-z0-9])?)/([a-z0-9]([-a-z0-9]*[a-z0-9])?):([0-9]{1,5})$`)

// ParsePrometheusService reads "namespace/service:port" — the form Lens and
// Headlamp use for a Prometheus Service address — with DNS-1123 names (at most
// 63 characters) and a port 1–65535.
func ParsePrometheusService(ref string) (namespace, name string, port int32, err error) {
	m := promServiceRef.FindStringSubmatch(ref)
	if m == nil || len(m[1]) > 63 || len(m[3]) > 63 {
		return "", "", 0, fmt.Errorf("prometheus_service: want namespace/service:port (lower-case names), got %q", ref)
	}
	p, _ := strconv.Atoi(m[5])
	if p < 1 || p > 65535 {
		return "", "", 0, fmt.Errorf("prometheus_service: port %d is out of range", p)
	}
	return m[1], m[3], int32(p), nil
}
