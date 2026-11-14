package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	fakediscovery "k8s.io/client-go/discovery/fake"
	fakedynamic "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/gatewayrow"
)

func withMeta(o *unstructured.Unstructured, uid, rv string, gen int64, finalizers []string) *unstructured.Unstructured {
	o.SetUID(types.UID(uid))
	o.SetResourceVersion(rv)
	o.SetGeneration(gen)
	if len(finalizers) > 0 {
		o.SetFinalizers(finalizers)
	}
	return o
}

// gatewayEventsAPI answers events lists as the API server filters them (the namespace in the path, involvedObject
// name and kind in the field selector) and records what it was asked; refuse answers 403 in that namespace.
type gatewayEventsAPI struct {
	mu     sync.Mutex
	events []corev1.Event
	asked  []string
	refuse string
}

func (a *gatewayEventsAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	sel := r.URL.Query().Get("fieldSelector")
	a.mu.Lock()
	a.asked = append(a.asked, r.URL.Path+"?"+sel)
	refuse := a.refuse
	a.mu.Unlock()
	ns, namespaced := strings.CutPrefix(strings.TrimSuffix(r.URL.Path, "/events"), "/api/v1/namespaces/")
	if !strings.HasSuffix(r.URL.Path, "/events") || (!namespaced && r.URL.Path != "/api/v1/events") {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if namespaced && ns == refuse {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}`))
		return
	}
	want := map[string]string{}
	for _, kv := range strings.Split(sel, ",") {
		k, v, _ := strings.Cut(kv, "=")
		want[k] = v
	}
	items := []corev1.Event{}
	for _, e := range a.events {
		kind, byKind := want["involvedObject.kind"]
		if (!namespaced || e.Namespace == ns) && e.InvolvedObject.Name == want["involvedObject.name"] && (!byKind || e.InvolvedObject.Kind == kind) {
			items = append(items, e)
		}
	}
	_ = json.NewEncoder(w).Encode(corev1.EventList{TypeMeta: metav1.TypeMeta{Kind: "EventList", APIVersion: "v1"}, Items: items})
}

func gatewayEvent(ns, kind, name, reason string, last time.Time) corev1.Event {
	return corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: name + "." + reason, Namespace: ns},
		InvolvedObject: corev1.ObjectReference{Kind: kind, Name: name, Namespace: ns},
		Type:           corev1.EventTypeNormal, Reason: reason, Message: reason + " by the controller", Count: 1,
		FirstTimestamp: metav1.NewTime(last), LastTimestamp: metav1.NewTime(last),
	}
}

func gwCond(kind, status string) interface{} {
	return map[string]interface{}{"type": kind, "status": status, "reason": kind, "message": "", "lastTransitionTime": "2026-11-01T00:00:00Z"}
}

// A cluster serving Gateway API at the versions v1.3 serves the kinds (gatewayclasses cluster-scoped), one object of
// each kind whose rules, listeners and parents are not alike, and events about some of them.
func newGatewayDescribeService(t *testing.T) (*Service, *gatewayEventsAPI) {
	t.Helper()
	fakeCS := fake.NewSimpleClientset()
	disc := fakeCS.Discovery().(*fakediscovery.FakeDiscovery)
	disc.Resources = []*metav1.APIResourceList{
		{GroupVersion: "gateway.networking.k8s.io/v1", APIResources: []metav1.APIResource{
			{Name: "gatewayclasses", Kind: "GatewayClass", Namespaced: false},
			{Name: "gateways", Kind: "Gateway", Namespaced: true},
			{Name: "httproutes", Kind: "HTTPRoute", Namespaced: true},
			{Name: "grpcroutes", Kind: "GRPCRoute", Namespaced: true},
		}},
		{GroupVersion: "gateway.networking.k8s.io/v1beta1", APIResources: []metav1.APIResource{
			{Name: "referencegrants", Kind: "ReferenceGrant", Namespaced: true},
		}},
		{GroupVersion: "gateway.networking.k8s.io/v1alpha3", APIResources: []metav1.APIResource{
			{Name: "backendtlspolicies", Kind: "BackendTLSPolicy", Namespaced: true},
		}},
	}

	gc := withMeta(obj("gateway.networking.k8s.io/v1", "GatewayClass", "", "envoy", map[string]interface{}{
		"controllerName": "gateway.envoyproxy.io/gatewayclass-controller",
	}, map[string]interface{}{
		"conditions":        []interface{}{gwCond("Accepted", "Unknown")},
		"supportedFeatures": []interface{}{map[string]interface{}{"name": "HTTPRoute"}, map[string]interface{}{"name": "GRPCRoute"}},
	}), "11111111-aaaa-4bbb-8ccc-000000000001", "4242", 3, []string{"gateway-exists-finalizer.gateway.networking.k8s.io"})
	rg := withMeta(obj("gateway.networking.k8s.io/v1beta1", "ReferenceGrant", "web", "allow-gw", map[string]interface{}{
		"from": []interface{}{map[string]interface{}{"group": "gateway.networking.k8s.io", "kind": "Gateway", "namespace": "infra"}},
		"to":   []interface{}{map[string]interface{}{"group": "", "kind": "Service"}},
	}, nil), "22222222-aaaa-4bbb-8ccc-000000000002", "77", 1, nil)
	gw := withMeta(obj("gateway.networking.k8s.io/v1", "Gateway", "web", "edge", map[string]interface{}{
		"gatewayClassName": "envoy",
		"listeners": []interface{}{
			map[string]interface{}{"name": "http", "port": int64(80), "protocol": "HTTP"},
			map[string]interface{}{"name": "alt", "port": int64(8080), "protocol": "HTTP", "hostname": "alt.example"},
		},
	}, map[string]interface{}{
		"conditions": []interface{}{gwCond("Accepted", "True"), gwCond("Programmed", "Unknown")},
		"listeners": []interface{}{
			map[string]interface{}{"name": "http", "attachedRoutes": int64(2), "supportedKinds": []interface{}{map[string]interface{}{"group": gatewayAPIGroup, "kind": "HTTPRoute"}}, "conditions": []interface{}{gwCond("Programmed", "True")}},
			map[string]interface{}{"name": "alt", "attachedRoutes": int64(1), "supportedKinds": []interface{}{}, "conditions": []interface{}{}},
		},
		"addresses": []interface{}{map[string]interface{}{"type": "IPAddress", "value": "10.0.0.7"}},
	}), "33333333-aaaa-4bbb-8ccc-000000000003", "90", 2, nil)
	hr := withMeta(obj("gateway.networking.k8s.io/v1", "HTTPRoute", "web", "shop", map[string]interface{}{
		"parentRefs": []interface{}{map[string]interface{}{"group": gatewayAPIGroup, "kind": "Gateway", "name": "edge", "sectionName": "http"}},
		"hostnames":  []interface{}{"shop.example"},
		"rules": []interface{}{
			map[string]interface{}{"backendRefs": []interface{}{
				map[string]interface{}{"name": "web", "port": int64(80), "weight": int64(9)},
				map[string]interface{}{"name": "web-canary", "port": int64(80), "weight": int64(1)},
			}},
			map[string]interface{}{
				"matches": []interface{}{map[string]interface{}{
					"path":        map[string]interface{}{"type": "PathPrefix", "value": "/api"},
					"queryParams": []interface{}{map[string]interface{}{"name": "v", "value": "2"}},
				}},
				"backendRefs": []interface{}{map[string]interface{}{"name": "api", "namespace": "backend", "port": int64(8080)}},
			},
		},
	}, map[string]interface{}{
		"parents": []interface{}{map[string]interface{}{
			"parentRef": map[string]interface{}{"name": "edge"}, "controllerName": "example.com/gateway",
			"conditions": []interface{}{gwCond("Accepted", "True"), gwCond("ResolvedRefs", "False")},
		}},
	}), "44444444-aaaa-4bbb-8ccc-000000000004", "91", 1, nil)
	gr := withMeta(obj("gateway.networking.k8s.io/v1", "GRPCRoute", "web", "rpc", map[string]interface{}{
		"parentRefs": []interface{}{map[string]interface{}{"name": "edge", "port": int64(80)}},
		"rules": []interface{}{map[string]interface{}{
			"matches":     []interface{}{map[string]interface{}{"method": map[string]interface{}{"service": "shop.Cart", "method": "Add", "type": "Exact"}}},
			"backendRefs": []interface{}{map[string]interface{}{"name": "grpc", "port": int64(9000)}},
		}},
	}, map[string]interface{}{
		"parents": []interface{}{map[string]interface{}{
			"parentRef": map[string]interface{}{"name": "edge"}, "controllerName": "example.com/gateway",
			"conditions": []interface{}{gwCond("Accepted", "Unknown")},
		}},
	}), "55555555-aaaa-4bbb-8ccc-000000000005", "92", 1, nil)
	bt := withMeta(obj("gateway.networking.k8s.io/v1alpha3", "BackendTLSPolicy", "web", "tls", map[string]interface{}{
		"targetRefs": []interface{}{map[string]interface{}{"group": "", "kind": "Service", "name": "web", "sectionName": "https"}},
		"validation": map[string]interface{}{"hostname": "web.example", "wellKnownCACertificates": "System"},
	}, map[string]interface{}{
		"ancestors": []interface{}{
			map[string]interface{}{"ancestorRef": map[string]interface{}{"name": "edge"}, "controllerName": "example.com/gateway", "conditions": []interface{}{}},
			map[string]interface{}{"ancestorRef": map[string]interface{}{"name": "edge-2"}, "controllerName": "example.com/gateway", "conditions": []interface{}{gwCond("Accepted", "False")}},
		},
	}), "66666666-aaaa-4bbb-8ccc-000000000006", "93", 1, nil)

	scheme := runtime.NewScheme()
	dyn := fakedynamic.NewSimpleDynamicClientWithCustomListKinds(scheme, map[schema.GroupVersionResource]string{
		{Group: gatewayAPIGroup, Version: "v1", Resource: "gatewayclasses"}:           "GatewayClassList",
		{Group: gatewayAPIGroup, Version: "v1", Resource: "gateways"}:                 "GatewayList",
		{Group: gatewayAPIGroup, Version: "v1", Resource: "httproutes"}:               "HTTPRouteList",
		{Group: gatewayAPIGroup, Version: "v1", Resource: "grpcroutes"}:               "GRPCRouteList",
		{Group: gatewayAPIGroup, Version: "v1beta1", Resource: "referencegrants"}:     "ReferenceGrantList",
		{Group: gatewayAPIGroup, Version: "v1alpha3", Resource: "backendtlspolicies"}: "BackendTLSPolicyList",
	}, gc, rg, hr, gr, bt)
	// the fake files an object under the resource it guesses from the kind, "gatewaies" for a Gateway
	if err := dyn.Tracker().Create(schema.GroupVersionResource{Group: gatewayAPIGroup, Version: "v1", Resource: "gateways"}, gw, "web"); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	events := &gatewayEventsAPI{events: []corev1.Event{
		withUID("33333333-aaaa-4bbb-8ccc-000000000003", gatewayEvent("web", "Gateway", "edge", "Synced", now.Add(-5*time.Minute))),
		withUID("33333333-aaaa-4bbb-8ccc-000000000003", gatewayEvent("web", "Gateway", "edge", "Programmed", now.Add(-time.Minute))),
		withUID("33333333-aaaa-4bbb-8ccc-000000000000", gatewayEvent("web", "Gateway", "edge", "OfTheOneBefore", now)),
		gatewayEvent("web", "HTTPRoute", "edge", "Attached", now.Add(-2*time.Minute)),
		withUID("11111111-aaaa-4bbb-8ccc-000000000001", gatewayEvent("default", "GatewayClass", "envoy", "Accepted", now.Add(-3*time.Minute))),
		withUID("22222222-aaaa-4bbb-8ccc-000000000002", gatewayEvent("web", "ReferenceGrant", "allow-gw", "Seen", now)),
	}}
	srv := httptest.NewServer(http.HandlerFunc(events.serve))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs, dynamic: dyn, discovery: disc})
	return s, events
}

func TestDescribeGatewayClass_CarriesObjectMeta(t *testing.T) {
	s, _ := newGatewayDescribeService(t)
	out, err := s.DescribeGatewayClass(context.Background(), "envoy")
	if err != nil {
		t.Fatalf("DescribeGatewayClass: %v", err)
	}
	if out["uid"] != "11111111-aaaa-4bbb-8ccc-000000000001" {
		t.Errorf("uid = %v", out["uid"])
	}
	if out["resource_version"] != "4242" {
		t.Errorf("resource_version = %v", out["resource_version"])
	}
	if out["generation"] != int64(3) {
		t.Errorf("generation = %v (%T)", out["generation"], out["generation"])
	}
	fin, _ := out["finalizers"].([]string)
	if len(fin) != 1 || fin[0] != "gateway-exists-finalizer.gateway.networking.k8s.io" {
		t.Errorf("finalizers = %v", out["finalizers"])
	}
	if out["controller_name"] != "gateway.envoyproxy.io/gatewayclass-controller" {
		t.Errorf("controller_name = %v", out["controller_name"])
	}
}

func TestDescribeReferenceGrant_CarriesObjectMeta(t *testing.T) {
	s, _ := newGatewayDescribeService(t)
	out, err := s.DescribeReferenceGrant(context.Background(), "web", "allow-gw")
	if err != nil {
		t.Fatalf("DescribeReferenceGrant: %v", err)
	}
	if out["uid"] != "22222222-aaaa-4bbb-8ccc-000000000002" || out["resource_version"] != "77" || out["generation"] != int64(1) {
		t.Errorf("metadata = uid %v rv %v gen %v", out["uid"], out["resource_version"], out["generation"])
	}
	if fin, ok := out["finalizers"].([]string); !ok || len(fin) != 0 {
		t.Errorf("finalizers of an object without any: %#v", out["finalizers"])
	}
	if out["namespace"] != "web" || out["name"] != "allow-gw" {
		t.Errorf("identity = %v/%v", out["namespace"], out["name"])
	}
}

// Each drawer reads the row its list shows (gatewayrow), so the two cannot disagree: every value of the list's row is
// in the describe answer, and the values the drawers read are the object's — the backends, match query params and
// parent section of an HTTPRoute (the drawer read them under the spec's names while describe renamed them), a
// Gateway's condition summary, a GRPCRoute parent's condition times.
func TestDescribeGatewayAPI_IsTheListRow(t *testing.T) {
	s, _ := newGatewayDescribeService(t)
	ctx := context.Background()
	// at walks keys and indexes; "#" at the end is the length of the list reached
	at := func(v interface{}, path ...interface{}) interface{} {
		for _, p := range path {
			if l, ok := v.([]map[string]interface{}); ok {
				v = maps2list(l)
			}
			switch k := p.(type) {
			case string:
				if l, ok := v.([]interface{}); ok && k == "#" {
					return len(l)
				}
				m, _ := v.(map[string]interface{})
				v = m[k]
			case int:
				l, _ := v.([]interface{})
				if k >= len(l) {
					return nil
				}
				v = l[k]
			}
		}
		return v
	}
	type check struct {
		path []interface{}
		want interface{}
	}
	p := func(path ...interface{}) []interface{} { return path }
	for _, tc := range []struct {
		resource, ns, name string
		describe           func() (map[string]interface{}, error)
		row                func(*unstructured.Unstructured) map[string]interface{}
		checks             []check
	}{
		{"gatewayclasses", "", "envoy", func() (map[string]interface{}, error) { return s.DescribeGatewayClass(ctx, "envoy") }, gatewayrow.GatewayClass, []check{
			{p("status"), "Unknown"}, {p("supported_features", "#"), 2},
		}},
		{"gateways", "web", "edge", func() (map[string]interface{}, error) { return s.DescribeGateway(ctx, "web", "edge") }, gatewayrow.Gateway, []check{
			{p("status"), "Accepted"}, {p("attached_routes"), int64(3)}, {p("status_listeners", 0, "attachedRoutes"), int64(2)},
			{p("conditions", 1, "status"), "Unknown"},
		}},
		{"httproutes", "web", "shop", func() (map[string]interface{}, error) { return s.DescribeHTTPRoute(ctx, "web", "shop") }, gatewayrow.Route, []check{
			{p("backend_refs_count"), 3}, {p("rules", 0, "backendRefs", "#"), 2}, {p("rules", 0, "backendRefs", 1, "weight"), int64(1)},
			{p("rules", 1, "matches", 0, "queryParams", "#"), 1}, {p("rules", 1, "backendRefs", 0, "namespace"), "backend"},
			{p("parent_refs", 0, "sectionName"), "http"}, {p("parents", 0, "controllerName"), "example.com/gateway"},
		}},
		{"grpcroutes", "web", "rpc", func() (map[string]interface{}, error) { return s.DescribeGRPCRoute(ctx, "web", "rpc") }, gatewayrow.Route, []check{
			{p("backend_refs_count"), 1}, {p("parent_refs", 0, "port"), int64(80)},
			{p("parents", 0, "conditions", 0, "lastTransitionTime"), "2026-11-01T00:00:00Z"},
		}},
		{"referencegrants", "web", "allow-gw", func() (map[string]interface{}, error) { return s.DescribeReferenceGrant(ctx, "web", "allow-gw") }, gatewayrow.ReferenceGrant, []check{
			{p("from", "#"), 1}, {p("to", 0, "kind"), "Service"},
		}},
		{"backendtlspolicies", "web", "tls", func() (map[string]interface{}, error) { return s.DescribeBackendTLSPolicy(ctx, "web", "tls") }, gatewayrow.Policy, []check{
			{p("target_refs", 0, "sectionName"), "https"}, {p("validation", "wellKnownCACertificates"), "System"},
			{p("ancestors", "#"), 2}, {p("ancestors", 1, "conditions", 0, "status"), "False"},
		}},
	} {
		t.Run(tc.resource, func(t *testing.T) {
			out, err := tc.describe()
			if err != nil {
				t.Fatalf("describe: %v", err)
			}
			o, err := s.GetResource(ctx, s.gatewayGVR(ctx, tc.resource), tc.ns, tc.name)
			if err != nil {
				t.Fatalf("get: %v", err)
			}
			for k, v := range tc.row(o) {
				if !reflect.DeepEqual(out[k], v) {
					t.Errorf("%s: describe %#v, list row %#v", k, out[k], v)
				}
			}
			for _, c := range tc.checks {
				if got := at(out, c.path...); !reflect.DeepEqual(got, c.want) {
					t.Errorf("%v: %#v, want %#v", c.path, got, c.want)
				}
			}
		})
	}
}

func maps2list(l []map[string]interface{}) []interface{} {
	out := make([]interface{}, len(l))
	for i, m := range l {
		out[i] = m
	}
	return out
}

// The events section lists what kubectl describe lists: the events about the object (involvedObject name and kind,
// in its namespace, or every namespace for a cluster-scoped GatewayClass), newest first, in the drawers' shape; a
// list the caller may not read leaves the section empty instead of failing the drawer.
func TestDescribeGatewayAPI_Events(t *testing.T) {
	s, api := newGatewayDescribeService(t)
	ctx := context.Background()
	events := func(out map[string]interface{}) []map[string]interface{} {
		l, _ := out["events"].([]map[string]interface{})
		return l
	}
	reasons := func(out map[string]interface{}) []string {
		got := []string{}
		for _, e := range events(out) {
			got = append(got, e["reason"].(string))
		}
		return got
	}
	gw, err := s.DescribeGateway(ctx, "web", "edge")
	if err != nil {
		t.Fatal(err)
	}
	if got := reasons(gw); !reflect.DeepEqual(got, []string{"Programmed", "Synced"}) {
		t.Errorf("Gateway events = %v, want the two about Gateway edge, newest first (not the HTTPRoute of the same name)", got)
	} else if e := events(gw)[0]; e["count"] != int32(1) || e["message"] != "Programmed by the controller" {
		t.Errorf("event shape = %#v", e)
	}
	gc, err := s.DescribeGatewayClass(ctx, "envoy")
	if err != nil {
		t.Fatal(err)
	}
	if got := reasons(gc); !reflect.DeepEqual(got, []string{"Accepted"}) {
		t.Errorf("GatewayClass events = %v, want the one recorded in namespace default", got)
	}
	api.mu.Lock()
	asked := append([]string(nil), api.asked...)
	api.mu.Unlock()
	for _, want := range []string{
		"/api/v1/namespaces/web/events?involvedObject.name=edge,involvedObject.kind=Gateway",
		"/api/v1/events?involvedObject.name=envoy,involvedObject.kind=GatewayClass",
	} {
		found := false
		for _, a := range asked {
			found = found || a == want
		}
		if !found {
			t.Errorf("not asked %s (asked %v)", want, asked)
		}
	}

	api.mu.Lock()
	api.refuse = "web"
	api.mu.Unlock()
	rg, err := s.DescribeReferenceGrant(ctx, "web", "allow-gw")
	if err != nil {
		t.Fatalf("a refused events list failed the drawer: %v", err)
	}
	checkEventsRefused(t, rg)
}
