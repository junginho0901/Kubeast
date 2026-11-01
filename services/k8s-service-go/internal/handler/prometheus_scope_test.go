package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A grant limited to namespaces is refused every read of the cluster's Prometheus — queries, discovery and the GPU
// metrics — before the store is asked (the handler has no service here, so a call past the gate would panic); a grant
// on another cluster, or one covering the whole cluster, passes the gate.
func TestPrometheusReadsRefuseANamespaceGrant(t *testing.T) {
	scoped := auth.TokenPayload{UserID: "u3", Email: "shop@example.com", Perms: auth.PermissionMatrix{"*": {"resource.pod.read"}},
		Roles: map[string]string{"self": "Read"}, Namespaces: map[string][]string{"self": {"shop", "cart"}}}
	h := &Handler{}
	reads := map[string]http.HandlerFunc{
		"/api/v1/prometheus/query?query=up":         h.PrometheusQuery,
		"/api/v1/prometheus/query_range?query=up":   h.PrometheusQueryRange,
		"/api/v1/prometheus/metrics":                h.PrometheusMetrics,
		"/api/v1/prometheus/labels?label=namespace": h.PrometheusLabels,
		"/api/v1/prometheus/rules":                  h.PrometheusRules,
		"/api/v1/prometheus/targets":                h.PrometheusTargets,
		"/api/v1/gpu/metrics":                       h.GetGPUMetrics,
	}
	for target, read := range reads {
		w := httptest.NewRecorder()
		read(w, logSearchRequestAs(target, "self", "", scoped))
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "limited to namespaces (shop, cart)") {
			t.Fatalf("%s: %d %s", target, w.Code, w.Body)
		}
	}
	for name, c := range map[string]struct {
		cluster string
		payload auth.TokenPayload
	}{
		"the grant is on another cluster": {"default", scoped},
		"a grant on the whole cluster":    {"self", podReader},
	} {
		if !promClusterWide(httptest.NewRecorder(), logSearchRequestAs("/api/v1/prometheus/query?query=up", c.cluster, "", c.payload)) {
			t.Fatalf("%s: refused", name)
		}
	}
	if len(promScope(logSearchRequestAs("/", "self", "", scoped))) != 2 || len(promScope(logSearchRequestAs("/", "self", "", podReader))) != 0 {
		t.Fatal("promScope")
	}
}
