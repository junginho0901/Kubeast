package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A store behind an authenticating proxy, registered as a Service, answers the API server's proxy 401 itself (the
// API server took Kubeast's credentials off the request). That is the store not answering, a 502 with its words —
// before, k8s-service answered 401 and the console signed the person out. The same for OpenCost.
func TestAStoresOwn401BehindTheProxyIsA502NotASignOut(t *testing.T) {
	t.Setenv("PROMETHEUS_ENABLED", "true")
	t.Setenv("PROMETHEUS_SERVICE", "monitoring/prometheus:9090")
	t.Setenv("PROMETHEUS_CLUSTER_LABEL", "")
	t.Setenv("COST_ENABLED", "true")
	unauthorized := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("Unauthorized"))
	}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch p := r.URL.Path; {
		case p == "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query":
			unauthorized(w)
		case p == "/api/v1/namespaces/opencost/services":
			_, _ = w.Write([]byte(`{"kind":"ServiceList","apiVersion":"v1","items":[{"metadata":{"name":"opencost","namespace":"opencost"},"spec":{"ports":[{"port":9003}]}}]}`))
		case strings.HasSuffix(p, "/services"):
			_, _ = w.Write([]byte(`{"kind":"ServiceList","apiVersion":"v1","items":[]}`))
		case p == "/api/v1/namespaces/opencost/services/opencost:9003/proxy/healthz":
			_, _ = w.Write([]byte("ok"))
		case p == "/api/v1/namespaces/opencost/services/opencost:9003/proxy/allocation/compute":
			unauthorized(w)
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		}
	}))
	defer api.Close()
	h := metricsHandler(t, api.URL)
	everything := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}
	for target, read := range map[string]http.HandlerFunc{
		"/api/v1/prometheus/query?query=up": h.PrometheusQuery,
		"/api/v1/cost?window=24h":           h.GetCost,
	} {
		w := httptest.NewRecorder()
		read(w, logSearchRequestAs(target, "c1", "", everything))
		if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "itself: Unauthorized") {
			t.Errorf("%s: %d %s", target, w.Code, w.Body)
		}
	}
}

// A Relay or Whisker behind an authenticating proxy answers the API server's proxy 401 or 403 itself: that is the flow
// source not answering, a 502 with its words. Only the API server's own refusal (a Kubernetes Status) stays a 403 —
// before, both read as "the cluster refused the read".
func TestAFlowSourcesOwn401Or403BehindTheProxyIsA502NotARefusal(t *testing.T) {
	var mu sync.Mutex
	var code int
	var ctype, body string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/namespaces/kube-system/services/https:hubble-relay:443/proxy/observer.Observer/GetFlows",
			"/api/v1/namespaces/calico-system/services/https:whisker:8443/proxy/whisker-backend/flows":
			mu.Lock()
			defer mu.Unlock()
			w.Header().Set("Content-Type", ctype)
			w.WriteHeader(code)
			_, _ = w.Write([]byte(body))
		default:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		}
	}))
	defer api.Close()
	refused := `{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"services \"https:x:443\" is forbidden: User \"dev@example.com\" cannot create resource \"services/proxy\" in API group \"\" in the namespace \"x\"","reason":"Forbidden","details":{"name":"https:x:443","kind":"services"},"code":403}`
	cases := []struct {
		name        string
		code        int
		ctype, body string
		status      int
		text        string
	}{
		{"the store's own 401", http.StatusUnauthorized, "text/plain; charset=utf-8", "Unauthorized", http.StatusBadGateway, "answered 401 itself, not the cluster: Unauthorized"},
		{"the store's own 403", http.StatusForbidden, "text/plain; charset=utf-8", "Forbidden", http.StatusBadGateway, "answered 403 itself, not the cluster: Forbidden"},
		{"the API server's refusal", http.StatusForbidden, "application/json", refused, http.StatusForbidden, "the cluster refused"},
	}
	for name, target := range map[string]netflows.Target{
		"Hubble Relay":   {Mode: "proxy", Relay: netflows.Relay{Namespace: "kube-system", Service: "hubble-relay", Port: 443}},
		"Calico Whisker": {Mode: "proxy", Source: netflows.SourceCalico, Relay: netflows.DefaultWhisker},
	} {
		s, err := netflows.New(netflows.Config{
			Clusters:     map[string]netflows.Target{"c1": target},
			DefaultRange: time.Hour, MaxRange: time.Hour, MaxFlows: 50, GraphMaxFlows: 400, Timeout: 2 * time.Second, PerUserPerMinute: 50,
		})
		if err != nil {
			t.Fatal(err)
		}
		h := metricsHandler(t, api.URL)
		h.auditStore = &memAudit{}
		h.SetNetworkFlows(s)
		h.netflowsCanI = func(context.Context, netflows.Target) (bool, error) { return true, nil }
		for _, c := range cases {
			mu.Lock()
			code, ctype, body = c.code, c.ctype, c.body
			mu.Unlock()
			w := httptest.NewRecorder()
			h.NetworkFlows(w, logSearchRequestAs("/api/v1/namespaces/demo/networkflows", "c1", "demo", flowReader))
			if w.Code != c.status || !strings.Contains(w.Body.String(), c.text) {
				t.Errorf("%s, %s: %d %s", name, c.name, w.Code, w.Body)
			}
		}
	}
}

// A flow read through the API server follows no redirect out of the Relay's or Whisker's Service: the request goes
// with the cluster's credentials and the person's headers, which another host must never get. It is a 502 saying so.
func TestNetworkFlowsThroughTheProxyFollowNoRedirectToAnotherHost(t *testing.T) {
	var mu sync.Mutex
	var reached []string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		reached = append(reached, r.Method+" "+r.URL.Path)
		mu.Unlock()
	}))
	defer other.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/namespaces/kube-system/services/https:hubble-relay:443/proxy/observer.Observer/GetFlows":
			// a POST: 307 keeps its method and body
			w.Header().Set("Location", other.URL+"/observer.Observer/GetFlows")
			w.WriteHeader(http.StatusTemporaryRedirect)
		case "/api/v1/namespaces/calico-system/services/https:whisker:8443/proxy/whisker-backend/flows":
			w.Header().Set("Location", other.URL+"/whisker-backend/flows")
			w.WriteHeader(http.StatusFound)
		default:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		}
	}))
	defer api.Close()
	for name, target := range map[string]netflows.Target{
		"Hubble Relay":   {Mode: "proxy", Relay: netflows.Relay{Namespace: "kube-system", Service: "hubble-relay", Port: 443}},
		"Calico Whisker": {Mode: "proxy", Source: netflows.SourceCalico, Relay: netflows.DefaultWhisker},
	} {
		s, err := netflows.New(netflows.Config{
			Clusters:     map[string]netflows.Target{"c1": target},
			DefaultRange: time.Hour, MaxRange: time.Hour, MaxFlows: 50, GraphMaxFlows: 400, Timeout: 2 * time.Second, PerUserPerMinute: 5,
		})
		if err != nil {
			t.Fatal(err)
		}
		h := metricsHandler(t, api.URL)
		h.auditStore = &memAudit{}
		h.SetNetworkFlows(s)
		h.netflowsCanI = func(context.Context, netflows.Target) (bool, error) { return true, nil }
		w := httptest.NewRecorder()
		h.NetworkFlows(w, logSearchRequestAs("/api/v1/namespaces/demo/networkflows", "c1", "demo", flowReader))
		if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "redirect not followed") || strings.Contains(w.Body.String(), other.URL) {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(reached) != 0 {
		t.Fatalf("another host was sent %v", reached)
	}
}
