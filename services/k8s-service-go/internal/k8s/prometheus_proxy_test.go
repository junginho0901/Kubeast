package k8s

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// proxyService is a Service whose cluster's API server answers every request with code and a Status of reason, and
// whose Prometheus is a Service reached through that API server's proxy.
func proxyService(t *testing.T, code int, reason string) *Service {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "")
	t.Setenv("PROMETHEUS_CLUSTER_LABEL", "")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/v1/namespaces/monitoring/services/prometheus:9/proxy/") {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","message":"the server is currently unable to handle the request","reason":"` + reason + `","code":` + strconv.Itoa(code) + `}`))
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{promQ: newPromQueryCache(0)}
	s.defaultBundle.Store(&clientBundle{clientset: cs, prom: &promCache{}, promSvc: &promServiceInfo{Namespace: "monitoring", Name: "prometheus", Port: 9}})
	return s
}

// A Prometheus Service that does not answer through the API server's proxy (503, 504) is the store's failure, not the
// cluster's: the error is ErrPrometheusUpstream (502 to the caller), not a 503 the cluster's breaker counts — before,
// a few dashboard reads of a Service on the wrong port marked the whole cluster unreachable. A refusal stays a refusal.
func TestPrometheusProxyNotAnsweringIsUpstreamNotTheCluster(t *testing.T) {
	for _, c := range []struct {
		code   int
		reason string
	}{{http.StatusServiceUnavailable, "ServiceUnavailable"}, {http.StatusGatewayTimeout, "Timeout"}, {http.StatusBadGateway, "InternalError"}} {
		_, err := proxyService(t, c.code, c.reason).PrometheusQuery(context.Background(), "up")
		if !errors.Is(err, ErrPrometheusUpstream) {
			t.Fatalf("%d: %v is not ErrPrometheusUpstream", c.code, err)
		}
		if apierrors.IsServiceUnavailable(err) || apierrors.IsTimeout(err) || apierrors.IsServerTimeout(err) {
			t.Fatalf("%d: %v still reads as the cluster's own 503", c.code, err)
		}
		if !strings.Contains(err.Error(), "status "+strconv.Itoa(c.code)) {
			t.Fatalf("%d: %v does not say the status", c.code, err)
		}
	}
	_, err := proxyService(t, http.StatusForbidden, "Forbidden").PrometheusQuery(context.Background(), "up")
	if !apierrors.IsForbidden(err) || errors.Is(err, ErrPrometheusUpstream) {
		t.Fatalf("403: %v should stay a refusal", err)
	}
}
