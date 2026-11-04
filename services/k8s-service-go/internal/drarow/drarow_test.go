package drarow

import (
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func obj(name, namespace string, spec, status map[string]interface{}) *unstructured.Unstructured {
	m := map[string]interface{}{"name": name, "creationTimestamp": "2026-11-04T01:02:03Z"}
	if namespace != "" {
		m["namespace"] = namespace
	}
	o := map[string]interface{}{"apiVersion": "resource.k8s.io/v1", "metadata": m}
	if spec != nil {
		o["spec"] = spec
	}
	if status != nil {
		o["status"] = status
	}
	return &unstructured.Unstructured{Object: o}
}

func l(v ...interface{}) []interface{} { return v }

type o = map[string]interface{}

// A claim's State is kubectl's STATE (printers.go resourceClaimState, Kubernetes v1.37).
func TestClaimState_AsKubectlPrintsIt(t *testing.T) {
	reserved := l(o{"resource": "pods", "name": "p", "uid": "u"})
	for _, tc := range []struct {
		name     string
		status   map[string]interface{}
		deleting bool
		want     string
	}{
		{"no status", nil, false, "pending"},
		{"allocation null", o{"allocation": nil}, false, "pending"},
		{"reserved without allocation", o{"reservedFor": reserved}, false, "pending"},
		{"allocated", o{"allocation": o{"devices": o{}}}, false, "allocated"},
		{"allocated and reserved", o{"allocation": o{}, "reservedFor": reserved}, false, "allocated,reserved"},
		{"allocated, empty reservedFor", o{"allocation": o{}, "reservedFor": l()}, false, "allocated"},
		{"deleted", nil, true, "deleted"},
		{"deleted while allocated", o{"allocation": o{}}, true, "deleted,allocated"},
		{"deleted while reserved", o{"allocation": o{}, "reservedFor": reserved}, true, "deleted,allocated,reserved"},
	} {
		u := obj("c", "ns", o{}, tc.status)
		if tc.deleting {
			u.Object["metadata"].(map[string]interface{})["deletionTimestamp"] = "2026-11-04T02:00:00Z"
		}
		if got := ClaimState(u); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
		if got := Claim(u)["state"]; got != tc.want {
			t.Errorf("%s: row state %q, want %q", tc.name, got, tc.want)
		}
	}
}

// The rows read the v1 shape: a slice's Node, Driver and Pool are kubectl's columns (spec.nodeName, spec.driver,
// spec.pool.name), a claim's requests are devices.requests, a template's are spec.spec.devices.requests.
func TestRows_V1Shape(t *testing.T) {
	slice := obj("s1", "", o{
		"driver": "gpu.example.com", "nodeName": "n1", "pool": o{"name": "n1", "generation": int64(1), "resourceSliceCount": int64(1)},
		"devices": l(o{"name": "gpu-0"}, o{"name": "gpu-1"}),
	}, nil)
	want := o{"name": "s1", "labels": map[string]string{}, "created_at": "2026-11-04T01:02:03Z",
		"node_name": "n1", "driver_name": "gpu.example.com", "pool_name": "n1", "device_count": 2, "all_nodes": false}
	if got := Slice(slice); !reflect.DeepEqual(got, want) {
		t.Errorf("slice row %v, want %v", got, want)
	}
	all := Slice(obj("s2", "", o{"driver": "qa.example.com", "allNodes": true, "pool": o{"name": "qa"}}, nil))
	if all["node_name"] != "" || all["all_nodes"] != true || all["device_count"] != 0 {
		t.Errorf("all-nodes slice %v", all)
	}

	req := func(name, class string) interface{} { return o{"name": name, "exactly": o{"deviceClassName": class}} }
	claim := Claim(obj("c", "ml", o{"devices": o{"requests": l(req("a", "gpu"), req("b", "gpu"))}}, nil))
	if claim["request_count"] != 2 || claim["namespace"] != "ml" {
		t.Errorf("claim row %v", claim)
	}
	tmpl := ClaimTemplate(obj("t", "ml", o{"spec": o{"devices": o{"requests": l(req("a", "gpu"))}}}, nil))
	if tmpl["request_count"] != 1 {
		t.Errorf("template row %v", tmpl)
	}
	dc := DeviceClass(obj("gpu", "", o{"selectors": l(o{"cel": o{"expression": "true"}}, o{"cel": o{"expression": "false"}})}, nil))
	if dc["selector_count"] != 2 {
		t.Errorf("device class row %v", dc)
	}
	if _, ok := dc["conditions"]; ok {
		t.Errorf("a v1 DeviceClass has no status: %v", dc)
	}
}

// Used By are the claims whose requests ask for the class: exactly or a firstAvailable subrequest.
func TestUsedBy_ExactlyAndFirstAvailable(t *testing.T) {
	claims := []unstructured.Unstructured{
		*obj("direct", "a", o{"devices": o{"requests": l(o{"name": "gpu", "exactly": o{"deviceClassName": "gpu.example.com"}})}}, o{"allocation": o{}}),
		*obj("ranked", "b", o{"devices": o{"requests": l(
			o{"name": "other", "exactly": o{"deviceClassName": "nic.example.com"}},
			o{"name": "pick", "firstAvailable": l(o{"name": "big", "deviceClassName": "big.example.com"}, o{"name": "any", "deviceClassName": "gpu.example.com"})},
		)}}, nil),
		*obj("elsewhere", "a", o{"devices": o{"requests": l(o{"name": "nic", "exactly": o{"deviceClassName": "nic.example.com"}})}}, nil),
		// v1beta1 (1.32–1.33): the request names the class itself
		*obj("beta", "c", o{"devices": o{"requests": l(o{"name": "old", "deviceClassName": "gpu.example.com"})}}, nil),
	}
	want := []map[string]interface{}{
		{"namespace": "a", "name": "direct", "state": "allocated", "requests": []string{"gpu"}},
		{"namespace": "b", "name": "ranked", "state": "pending", "requests": []string{"pick"}},
		{"namespace": "c", "name": "beta", "state": "pending", "requests": []string{"old"}},
	}
	if got := UsedBy("gpu.example.com", claims); !reflect.DeepEqual(got, want) {
		t.Errorf("used by %v, want %v", got, want)
	}
}

// A slice's allocations are the results whose driver, pool and device are the slice's — the same device name of
// another driver or pool is another device.
func TestSliceAllocations_DriverPoolAndDevice(t *testing.T) {
	slice := obj("s1", "", o{"driver": "gpu.example.com", "pool": o{"name": "n1"}, "devices": l(o{"name": "gpu-0"}, o{"name": "gpu-1"})}, nil)
	res := func(request, driver, pool, device string) interface{} {
		return o{"request": request, "driver": driver, "pool": pool, "device": device}
	}
	claims := []unstructured.Unstructured{
		*obj("one", "a", nil, o{"allocation": o{"devices": o{"results": l(res("gpu", "gpu.example.com", "n1", "gpu-1"))}}}),
		*obj("other-driver", "a", nil, o{"allocation": o{"devices": o{"results": l(res("gpu", "qa.example.com", "n1", "gpu-0"))}}}),
		*obj("other-pool", "b", nil, o{"allocation": o{"devices": o{"results": l(res("gpu", "gpu.example.com", "n2", "gpu-0"))}}}),
		*obj("not-in-slice", "b", nil, o{"allocation": o{"devices": o{"results": l(res("gpu", "gpu.example.com", "n1", "gpu-7"))}}}),
		*obj("pending", "b", nil, nil),
	}
	want := []map[string]interface{}{{"claim_namespace": "a", "claim_name": "one", "request": "gpu", "device": "gpu-1", "driver": "gpu.example.com", "pool": "n1"}}
	if got := SliceAllocations(slice, claims); !reflect.DeepEqual(got, want) {
		t.Errorf("allocations %v, want %v", got, want)
	}
}

// The pods holding devices are the pods an allocated claim is reserved for, in the claim's namespace: not a claim
// without an allocation, not a consumer of another resource, each pod once.
func TestReservedPods_AllocatedClaimsPods(t *testing.T) {
	pod := func(name string) interface{} { return o{"resource": "pods", "name": name, "uid": name} }
	claims := []unstructured.Unstructured{
		*obj("shared", "ml", nil, o{"allocation": o{}, "reservedFor": l(pod("train-1"), pod("train-0"))}),
		*obj("again", "ml", nil, o{"allocation": o{}, "reservedFor": l(pod("train-0"))}),
		*obj("made", "a", nil, o{"allocation": o{}, "reservedFor": l(pod("infer"))}),
		*obj("by-a-set", "a", nil, o{"allocation": o{}, "reservedFor": l(o{"apiGroup": "apps", "resource": "statefulsets", "name": "db", "uid": "s"})}),
		*obj("same-name-group", "a", nil, o{"allocation": o{}, "reservedFor": l(o{"apiGroup": "example.com", "resource": "pods", "name": "x", "uid": "x"})}),
		*obj("not-allocated", "a", nil, o{"reservedFor": l(pod("waiting"))}),
		*obj("pending", "a", nil, nil),
	}
	want := []map[string]interface{}{
		{"namespace": "a", "name": "infer"},
		{"namespace": "ml", "name": "train-0"},
		{"namespace": "ml", "name": "train-1"},
	}
	if got := ReservedPods(claims); !reflect.DeepEqual(got, want) {
		t.Errorf("reserved pods %v, want %v", got, want)
	}
	if got := ReservedPods(nil); got == nil || len(got) != 0 {
		t.Errorf("no claims %#v, want an empty list", got)
	}
}

func strp(s string) *string { return &s }

// A pod uses a claim it names or the claim made for it from a template; a template's claims are what its pods'
// status.resourceClaimStatuses record for the entries naming it.
func TestPodClaims(t *testing.T) {
	direct := &corev1.Pod{Spec: corev1.PodSpec{ResourceClaims: []corev1.PodResourceClaim{{Name: "gpu", ResourceClaimName: strp("shared")}}}}
	made := &corev1.Pod{
		Spec: corev1.PodSpec{ResourceClaims: []corev1.PodResourceClaim{
			{Name: "gpu", ResourceClaimTemplateName: strp("one-gpu")},
			{Name: "nic", ResourceClaimTemplateName: strp("one-nic")},
			{Name: "later", ResourceClaimTemplateName: strp("one-gpu")},
		}},
		Status: corev1.PodStatus{ResourceClaimStatuses: []corev1.PodResourceClaimStatus{
			{Name: "gpu", ResourceClaimName: strp("p-gpu-x7k2q")},
			{Name: "nic", ResourceClaimName: strp("p-nic-a1b2c")},
			{Name: "later"},
		}},
	}
	if !PodUsesClaim(direct, "shared") || PodUsesClaim(direct, "p-gpu-x7k2q") {
		t.Error("a pod uses the claim it names, no other")
	}
	if !PodUsesClaim(made, "p-gpu-x7k2q") || PodUsesClaim(made, "one-gpu") {
		t.Error("a pod uses the claim made for it, not one named like the template")
	}
	if got := PodTemplateClaims(made, "one-gpu"); !reflect.DeepEqual(got, []string{"p-gpu-x7k2q"}) {
		t.Errorf("claims made from one-gpu %v", got)
	}
	if got := PodTemplateClaims(direct, "one-gpu"); got != nil {
		t.Errorf("a pod naming no template %v", got)
	}
}
