package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// A cluster serving resource.k8s.io/v1 with the DRA example driver's shape: a slice of two devices on n1, a claim made
// for pod p from the template one-gpu holding gpu-1, a claim nobody holds, and a class with config and an extended
// resource name.
const (
	draSlice = `{"apiVersion":"resource.k8s.io/v1","kind":"ResourceSlice","metadata":{"name":"s1","creationTimestamp":"2026-11-04T01:00:00Z"},
		"spec":{"driver":"gpu.example.com","nodeName":"n1","pool":{"name":"n1","generation":1,"resourceSliceCount":1},
		"devices":[{"name":"gpu-0","attributes":{"index":{"int":0}}},{"name":"gpu-1","attributes":{"index":{"int":1}}}]}}`
	draMade = `{"apiVersion":"resource.k8s.io/v1","kind":"ResourceClaim","metadata":{"name":"p-gpu-x7k2q","namespace":"ml","creationTimestamp":"2026-11-04T01:00:00Z"},
		"spec":{"devices":{"requests":[{"name":"gpu","exactly":{"deviceClassName":"gpu.example.com","allocationMode":"ExactCount","count":1}}]}},
		"status":{"allocation":{"devices":{"results":[{"request":"gpu","driver":"gpu.example.com","pool":"n1","device":"gpu-1"}]}},
		"reservedFor":[{"resource":"pods","name":"p","uid":"1"}]}}`
	draIdle = `{"apiVersion":"resource.k8s.io/v1","kind":"ResourceClaim","metadata":{"name":"idle","namespace":"ml","creationTimestamp":"2026-11-04T01:00:00Z"},
		"spec":{"devices":{"requests":[{"name":"gpu","exactly":{"deviceClassName":"other.example.com"}}]}}}`
	draClass = `{"apiVersion":"resource.k8s.io/v1","kind":"DeviceClass","metadata":{"name":"gpu.example.com","creationTimestamp":"2026-11-04T01:00:00Z"},
		"spec":{"selectors":[{"cel":{"expression":"device.driver == 'gpu.example.com'"}}],
		"config":[{"opaque":{"driver":"gpu.example.com","parameters":{"sharing":"TimeSlicing"}}}],"extendedResourceName":"example.com/gpu"}}`
	draTemplate = `{"apiVersion":"resource.k8s.io/v1","kind":"ResourceClaimTemplate","metadata":{"name":"one-gpu","namespace":"ml","creationTimestamp":"2026-11-04T01:00:00Z"},
		"spec":{"spec":{"devices":{"requests":[{"name":"gpu","exactly":{"deviceClassName":"gpu.example.com"}}]}}}}`
	draPods = `{"apiVersion":"v1","kind":"PodList","metadata":{},"items":[
		{"metadata":{"name":"p","namespace":"ml"},"spec":{"nodeName":"n1","containers":[{"name":"c"}],"resourceClaims":[{"name":"gpu","resourceClaimTemplateName":"one-gpu"}]},
		 "status":{"phase":"Running","resourceClaimStatuses":[{"name":"gpu","resourceClaimName":"p-gpu-x7k2q"}]}},
		{"metadata":{"name":"q","namespace":"ml"},"spec":{"containers":[{"name":"c"}],"resourceClaims":[{"name":"gpu","resourceClaimTemplateName":"one-gpu"}]},
		 "status":{"phase":"Pending"}},
		{"metadata":{"name":"bystander","namespace":"ml"},"spec":{"containers":[{"name":"c"}]},"status":{"phase":"Running"}}]}`
)

func newDRAService(t *testing.T) (*Service, *[]string) {
	t.Helper()
	return newDRAServiceWithEvents(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"kind":"EventList","apiVersion":"v1","metadata":{},"items":[]}`))
	})
}

func newDRAServiceWithEvents(t *testing.T, events http.HandlerFunc) (*Service, *[]string) {
	t.Helper()
	var podLimits []string
	list := func(kind, items string) string {
		return `{"apiVersion":"resource.k8s.io/v1","kind":"` + kind + `","metadata":{},"items":[` + items + `]}`
	}
	answers := map[string]string{
		"/apis/resource.k8s.io/v1/resourceslices":                               list("ResourceSliceList", draSlice),
		"/apis/resource.k8s.io/v1/resourceslices/s1":                            draSlice,
		"/apis/resource.k8s.io/v1/resourceclaims":                               list("ResourceClaimList", draMade+","+draIdle),
		"/apis/resource.k8s.io/v1/namespaces/ml/resourceclaims/p-gpu-x7k2q":     draMade,
		"/apis/resource.k8s.io/v1/deviceclasses/gpu.example.com":                draClass,
		"/apis/resource.k8s.io/v1/namespaces/ml/resourceclaimtemplates/one-gpu": draTemplate,
		"/api/v1/namespaces/ml/pods":                                            draPods,
		"/api/v1/pods":                                                          draPods,
		"/api/v1/nodes":                                                         `{"apiVersion":"v1","kind":"NodeList","metadata":{},"items":[]}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/namespaces/ml/pods" {
			podLimits = append(podLimits, r.URL.Query().Get("limit"))
		}
		if strings.HasSuffix(r.URL.Path, "/events") {
			events(w, r)
			return
		}
		if body, ok := answers[r.URL.Path]; ok {
			_, _ = w.Write([]byte(body))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	dyn, err := dynamic.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{resolveCache: map[string]resolvedEntry{}}
	for _, r := range []string{"deviceclasses", "resourceclaims", "resourceclaimtemplates", "resourceslices"} {
		s.resolveCache["default|resource.k8s.io/"+r] = resolvedEntry{ok: true, at: time.Now(),
			res: resolvedResource{GVR: schema.GroupVersionResource{Group: "resource.k8s.io", Version: "v1", Resource: r}}}
	}
	s.defaultBundle.Store(&clientBundle{clientset: cs, dynamic: dyn})
	return s, &podLimits
}

// The slice list and drawer read the v1 shape (spec.driver, spec.nodeName, spec.pool, spec.devices), and the drawer's
// allocations are the claims holding its devices, worked out on the server.
func TestResourceSlice_V1ListAndDescribe(t *testing.T) {
	s, _ := newDRAService(t)
	ctx := context.Background()
	got, err := s.GetResourceSlices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0]["node_name"] != "n1" || got[0]["driver_name"] != "gpu.example.com" || got[0]["pool_name"] != "n1" || got[0]["device_count"] != 2 {
		t.Fatalf("slice list %v", got)
	}
	d, err := s.DescribeResourceSlice(ctx, "s1")
	if err != nil {
		t.Fatal(err)
	}
	if d["node_name"] != "n1" || d["driver_name"] != "gpu.example.com" || len(d["devices"].([]interface{})) != 2 {
		t.Fatalf("slice describe %v", d)
	}
	if pool := d["pool"].(map[string]interface{}); pool["name"] != "n1" {
		t.Fatalf("slice pool %v", pool)
	}
	want := []map[string]interface{}{{"claim_namespace": "ml", "claim_name": "p-gpu-x7k2q", "request": "gpu", "device": "gpu-1", "driver": "gpu.example.com", "pool": "n1"}}
	if !reflect.DeepEqual(d["allocations"], want) {
		t.Fatalf("allocations %v, want %v", d["allocations"], want)
	}
}

// The class drawer's config is the v1 array, the extended resource name is there, and Used By counts the claims whose
// requests name the class.
func TestDeviceClass_DescribeConfigAndUsedBy(t *testing.T) {
	s, _ := newDRAService(t)
	d, err := s.DescribeDeviceClass(context.Background(), "gpu.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if cfg, ok := d["config"].([]interface{}); !ok || len(cfg) != 1 {
		t.Fatalf("config %v", d["config"])
	}
	if d["extended_resource_name"] != "example.com/gpu" {
		t.Fatalf("extended resource name %v", d["extended_resource_name"])
	}
	if _, ok := d["suitable_nodes"]; ok {
		t.Fatalf("suitableNodes is not a v1 field: %v", d)
	}
	want := []map[string]interface{}{{"namespace": "ml", "name": "p-gpu-x7k2q", "state": "allocated,reserved", "requests": []string{"gpu"}}}
	if !reflect.DeepEqual(d["used_by"], want) {
		t.Fatalf("used by %v, want %v", d["used_by"], want)
	}
}

// A claim made from a template is used by the pod its status names, not by every pod naming the template; the pods
// are read a page at a time.
func TestResourceClaim_DescribeStateAndUsingPods(t *testing.T) {
	s, limits := newDRAService(t)
	d, err := s.DescribeResourceClaim(context.Background(), "ml", "p-gpu-x7k2q")
	if err != nil {
		t.Fatal(err)
	}
	if d["state"] != "allocated,reserved" {
		t.Fatalf("state %v", d["state"])
	}
	want := []map[string]interface{}{{"name": "p", "namespace": "ml", "status": "Running", "node_name": "n1"}}
	if !reflect.DeepEqual(d["using_pods"], want) {
		t.Fatalf("using pods %v, want %v", d["using_pods"], want)
	}
	if len(*limits) == 0 || (*limits)[0] != strconv.Itoa(podListChunk) {
		t.Fatalf("pod lists %v", *limits)
	}
}

// A template's related claims are the claims its pods' statuses name (q's is not made yet).
func TestResourceClaimTemplate_DescribeRelatedClaims(t *testing.T) {
	s, _ := newDRAService(t)
	d, err := s.DescribeResourceClaimTemplate(context.Background(), "ml", "one-gpu")
	if err != nil {
		t.Fatal(err)
	}
	want := []map[string]interface{}{{"name": "p-gpu-x7k2q", "namespace": "ml", "pod": "p"}}
	if !reflect.DeepEqual(d["related_claims"], want) {
		t.Fatalf("related claims %v, want %v", d["related_claims"], want)
	}
}

// The GPU Dashboard names the pods an allocated claim is reserved for (p, from the claim made for it), not a pod whose
// claim is not made yet (q) or a pod naming none; a cluster without DRA names none.
func TestGPUDashboard_NamesThePodsHoldingDRADevices(t *testing.T) {
	s, _ := newDRAService(t)
	res, err := s.GetGPUDashboard(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []map[string]interface{}{{"namespace": "ml", "name": "p"}}
	if !reflect.DeepEqual(res["dra_pods"], want) {
		t.Fatalf("dra pods %v, want %v", res["dra_pods"], want)
	}

	none, err := (&listAPI{objects: map[string]any{"/api/v1/nodes": corev1.NodeList{}}}).serve(t).GetGPUDashboard(context.Background())
	if got, ok := none["dra_pods"].([]map[string]interface{}); err != nil || !ok || len(got) != 0 {
		t.Fatalf("no DRA: %#v %v", none["dra_pods"], err)
	}
}
