package cluster

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var promServiceRef = regexp.MustCompile(`^([a-z0-9]([-a-z0-9]*[a-z0-9])?)/([a-z0-9]([-a-z0-9]*[a-z0-9])?):([0-9]{1,5})((/[A-Za-z0-9._~-]+)*)$`)

// ParsePrometheusService reads "namespace/service:port" — the form Lens and
// Headlamp use for a Prometheus Service address — with DNS-1123 names (at most
// 63 characters) and a port 1–65535, and an optional path the API sits under
// ("monitoring/vmselect-main:8481/select/0/prometheus" for a VictoriaMetrics
// cluster); path segments are plain (no "." or "..", no query).
func ParsePrometheusService(ref string) (namespace, name string, port int32, path string, err error) {
	m := promServiceRef.FindStringSubmatch(ref)
	if m == nil || len(m[1]) > 63 || len(m[3]) > 63 || len(m[6]) > 200 {
		return "", "", 0, "", fmt.Errorf("prometheus_service: want namespace/service:port[/path] (lower-case names), got %q", ref)
	}
	for _, seg := range strings.Split(m[6], "/")[1:] {
		if seg == "." || seg == ".." {
			return "", "", 0, "", fmt.Errorf("prometheus_service: path segment %q is not allowed", seg)
		}
	}
	p, _ := strconv.Atoi(m[5])
	if p < 1 || p > 65535 {
		return "", "", 0, "", fmt.Errorf("prometheus_service: port %d is out of range", p)
	}
	return m[1], m[3], int32(p), m[6], nil
}
