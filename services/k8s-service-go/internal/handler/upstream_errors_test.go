package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/traces"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func TestAClusterThatCannotBeReachedAnswersWithoutItsAddress(t *testing.T) {
	err := fmt.Errorf("list pods: %w", &url.Error{Op: "Get", URL: "https://10.0.0.9:6443/api/v1/pods", Err: errors.New("dial tcp 10.0.0.9:6443: connect: connection refused")})
	h := &Handler{}
	w := httptest.NewRecorder()
	h.handleError(w, err)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d: the status still comes from the whole error", w.Code)
	}
	if strings.Contains(w.Body.String(), "10.0.0.9") {
		t.Fatalf("body names the API server: %s", w.Body)
	}
	if !strings.Contains(w.Body.String(), "list pods:") {
		t.Fatalf("body lost what failed: %s", w.Body)
	}
}

func TestATraceStoreThatCannotBeReachedAnswersWithoutItsAddress(t *testing.T) {
	gone := httptest.NewServer(http.NotFoundHandler())
	addr := gone.URL
	gone.Close()
	s, err := traces.New(traces.Config{
		Enabled: true, URL: addr + "/api/datasources/proxy/uid/tempo",
		ClusterAttribute: "k8s.cluster.name", NamespaceAttribute: "k8s.namespace.name",
		Clusters:     map[string]string{"self": "kubeast"},
		DefaultRange: time.Hour, MaxRange: 24 * time.Hour, MaxTraces: 20, Timeout: 500 * time.Millisecond, PerUserPerMinute: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	store := &memAudit{}
	h := &Handler{auditStore: store}
	h.SetTraceStore(s)
	h.logSearchCanI = func(context.Context, string) (bool, error) { return true, nil }
	w := httptest.NewRecorder()
	h.TraceSearchNamespace(w, logSearchRequestAs(traceTarget("/api/v1/namespaces/shop/traces/search", `{ status = error }`), "self", "shop", podReader))
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	for _, secret := range []string{strings.TrimPrefix(addr, "http://"), "127.0.0.1", "datasources"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("body names %s: %s", secret, w.Body)
		}
	}
	// The audit row keeps the whole error for whoever reads it.
	if len(store.rows) != 1 || !strings.Contains(store.rows[0].Error, "127.0.0.1") {
		t.Fatalf("audit row = %+v", store.rows)
	}
}

func TestAStoreStatusNamesItsAddressOnlyToThoseWhoRegisterIt(t *testing.T) {
	full := func() map[string]interface{} {
		return map[string]interface{}{
			"available": false, "source": "external", "endpoint": "http://store.internal:9090", "auth": true,
			"message": `Get "http://store.internal:9090/-/healthy": dial tcp 10.1.2.3:9090: connect: connection refused`,
		}
	}
	for name, perms := range map[string]auth.PermissionMatrix{
		"global admin":          {"*": {"*"}},
		"cluster update holder": {"*": {auth.PermClustersUpdate}},
		"cluster create holder": {"*": {auth.PermClustersCreate}},
	} {
		got := storeStatusFor(auth.TokenPayload{Perms: perms}, full())
		if got["endpoint"] != "http://store.internal:9090" || !strings.Contains(got["message"].(string), "connection refused") {
			t.Errorf("%s: %v", name, got)
		}
	}
	for name, perms := range map[string]auth.PermissionMatrix{
		"reader":         {"c": {"resource.*.read"}},
		"cluster admin":  {"c": {"*"}},
		"other page key": {"*": {"admin.audit.read"}},
	} {
		got := storeStatusFor(auth.TokenPayload{Perms: perms}, full())
		body, _ := json.Marshal(got)
		if _, ok := got["endpoint"]; ok || strings.Contains(string(body), "store.internal") || strings.Contains(string(body), "10.1.2.3") {
			t.Errorf("%s: %s", name, body)
		}
		if got["available"] != false || got["source"] != "external" {
			t.Errorf("%s lost the state: %s", name, body)
		}
	}
}

func TestAddressModeFlowsDoNotAnswerTheRegisteredAddress(t *testing.T) {
	got := relayLabel(netflows.Target{Mode: "address", URL: "https://relay.internal:4245"})
	if strings.Contains(got, "relay.internal") {
		t.Fatalf("relay = %q", got)
	}
	proxy := netflows.Target{Mode: "proxy", Relay: netflows.Relay{Namespace: "kube-system", Service: "hubble-relay", Port: 443}}
	if got := relayLabel(proxy); got != "kube-system/hubble-relay:443" {
		t.Fatalf("relay = %q", got)
	}
}
