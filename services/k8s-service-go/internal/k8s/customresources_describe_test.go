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
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// crAPI answers as the API server does for custom resources asked as a Table (the CRD's columns, each row with its
// object) — a list over every namespace, or one object by its path — and for events filtered by involvedObject name
// and kind; it records the paths, Accept headers and selectors it was asked.
type crAPI struct {
	mu      sync.Mutex
	columns []metav1.TableColumnDefinition
	objects map[string][]interface{} // object path → cells (the object's JSON first)
	events  []corev1.Event
	asked   []string
}

func (a *crAPI) serve(w http.ResponseWriter, r *http.Request) {
	asked := r.URL.Path + "?" + r.URL.RawQuery
	ns, isEvents := strings.CutSuffix(r.URL.Path, "/events")
	if !isEvents {
		asked += " " + r.Header.Get("Accept")
	}
	a.mu.Lock()
	a.asked = append(a.asked, asked)
	a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if isEvents {
		ns, namespaced := strings.CutPrefix(ns, "/api/v1/namespaces/")
		want := map[string]string{}
		for _, kv := range strings.Split(r.URL.Query().Get("fieldSelector"), ",") {
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
		return
	}
	if r.Header.Get("Accept") != tableAccept || r.URL.Query().Get("includeObject") != "Object" {
		w.WriteHeader(http.StatusNotAcceptable)
		return
	}
	table := metav1.Table{TypeMeta: metav1.TypeMeta{Kind: "Table", APIVersion: "meta.k8s.io/v1"}, ColumnDefinitions: a.columns}
	for path, cells := range a.objects {
		if path == r.URL.Path || listPath(path) == r.URL.Path {
			raw, _ := json.Marshal(cells[0])
			table.Rows = append(table.Rows, metav1.TableRow{Cells: cells[1:], Object: runtime.RawExtension{Raw: raw}})
		}
	}
	if len(table.Rows) == 0 {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		return
	}
	_ = json.NewEncoder(w).Encode(table)
}

// listPath is the path listing an object over every namespace: /apis/<group>/<version>/<plural>
func listPath(objectPath string) string {
	p := strings.Split(objectPath, "/")
	if len(p) == 8 { // "", apis, group, version, namespaces, ns, plural, name
		return strings.Join([]string{"", p[1], p[2], p[3], p[6]}, "/")
	}
	return strings.Join(p[:5], "/")
}

func newCRDescribeService(t *testing.T) (*Service, *crAPI) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	widget := map[string]interface{}{
		"apiVersion": "numbers.kubeast.io/v1", "kind": "Widget",
		"metadata": map[string]interface{}{
			"name": "w1", "namespace": "shop", "uid": "77777777-aaaa-4bbb-8ccc-000000000007", "resourceVersion": "501", "generation": 2,
			"creationTimestamp": "2026-11-01T00:00:00Z", "labels": map[string]interface{}{"app": "shop"},
			"finalizers":      []interface{}{"numbers.kubeast.io/keep"},
			"ownerReferences": []interface{}{map[string]interface{}{"apiVersion": "v1", "kind": "ConfigMap", "name": "owner", "uid": "88888888-aaaa-4bbb-8ccc-000000000008"}},
			"managedFields": []interface{}{
				map[string]interface{}{"manager": "kubectl", "operation": "Apply", "apiVersion": "numbers.kubeast.io/v1", "time": "2026-11-01T00:00:00Z", "fieldsType": "FieldsV1", "fieldsV1": map[string]interface{}{}},
				map[string]interface{}{"manager": "kubectl-patch", "operation": "Update", "apiVersion": "numbers.kubeast.io/v1", "subresource": "status", "time": "2026-11-01T00:01:00Z", "fieldsType": "FieldsV1", "fieldsV1": map[string]interface{}{}},
			},
		},
		"spec":   map[string]interface{}{"size": "large", "tags": []interface{}{"a", "b"}},
		"status": map[string]interface{}{"lastSeen": "2026-11-02T01:00:00Z"},
	}
	other := map[string]interface{}{
		"apiVersion": "numbers.kubeast.io/v1", "kind": "Widget",
		"metadata": map[string]interface{}{"name": "w2", "namespace": "lab", "uid": "u2", "creationTimestamp": "2026-11-01T00:00:00Z"},
		"spec":     map[string]interface{}{"size": "small"},
	}
	gadget := map[string]interface{}{
		"apiVersion": "numbers.kubeast.io/v1", "kind": "Gadget",
		"metadata": map[string]interface{}{"name": "g1", "uid": "u3", "creationTimestamp": "2026-11-01T00:00:00Z"},
	}
	api := &crAPI{
		columns: []metav1.TableColumnDefinition{
			{Name: "Name", Type: "string", Format: "name"},
			{Name: "Size", Type: "string"},
			{Name: "Tags", Type: "string"},
			{Name: "Generation", Type: "integer"},
			{Name: "Seen", Type: "date"},
			{Name: "Owner", Type: "string", Priority: 1},
			{Name: "Age", Type: "date"},
		},
		objects: map[string][]interface{}{
			"/apis/numbers.kubeast.io/v1/namespaces/shop/widgets/w1": {widget, "w1", "large", `["a","b"]`, 2, "23h", nil, "3d"},
			"/apis/numbers.kubeast.io/v1/namespaces/lab/widgets/w2":  {other, "w2", "small", nil, 1, nil, nil, "3d"},
			"/apis/numbers.kubeast.io/v1/gadgets/g1":                 {gadget, "g1", nil, nil, nil, nil, nil, "3d"},
		},
		events: []corev1.Event{
			gatewayEvent("shop", "Widget", "w1", "Synced", now.Add(-5*time.Minute)),
			gatewayEvent("shop", "Widget", "w1", "Ready", now.Add(-time.Minute)),
			gatewayEvent("shop", "ConfigMap", "w1", "Elsewhere", now),
			gatewayEvent("lab", "Widget", "w1", "OtherNamespace", now),
			gatewayEvent("default", "Gadget", "g1", "Seen", now.Add(-2*time.Minute)),
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	return s, api
}

// A custom resource's drawer reads the row its list shows — the API server's Table for that one object, every column
// but the name and Age, with the server's value — plus its metadata and the events kubectl describe lists about it.
func TestDescribeCustomResourceInstance_IsTheListRow(t *testing.T) {
	s, api := newCRDescribeService(t)
	ctx := context.Background()
	list, err := s.GetCustomResourceInstances(ctx, "numbers.kubeast.io", "v1", "widgets")
	if err != nil {
		t.Fatal(err)
	}
	var row map[string]interface{}
	for _, r := range list {
		if r["name"] == "w1" {
			row = r
		}
	}
	if row == nil {
		t.Fatalf("w1 is not in the list: %v", list)
	}
	d, err := s.DescribeCustomResourceInstance(ctx, "numbers.kubeast.io", "v1", "widgets", "shop", "w1")
	if err != nil {
		t.Fatal(err)
	}
	for k, want := range row {
		if !reflect.DeepEqual(d[k], want) {
			t.Errorf("%s: describe %v, the list row %v", k, d[k], want)
		}
	}
	var cells []string
	printed, _ := d["printer_cells"].([]map[string]interface{})
	for _, c := range printed {
		v, _ := json.Marshal(c["value"])
		cells = append(cells, c["name"].(string)+"="+string(v))
	}
	if want := []string{`Size="large"`, `Tags="[\"a\",\"b\"]"`, `Generation=2`, `Seen="23h"`, `Owner=null`}; !reflect.DeepEqual(cells, want) {
		t.Errorf("printer cells %v, want %v", cells, want)
	}
	for k, want := range map[string]interface{}{
		"uid": "77777777-aaaa-4bbb-8ccc-000000000007", "resource_version": "501", "api_version": "numbers.kubeast.io/v1",
		"kind": "Widget", "created_at": "2026-11-01T00:00:00Z",
	} {
		if d[k] != want {
			t.Errorf("%s = %v, want %v", k, d[k], want)
		}
	}
	if mf, _ := d["managed_fields"].([]map[string]interface{}); len(mf) != 2 || mf[1]["subresource"] != "status" {
		t.Errorf("managed fields %v", mf)
	}
	if refs, _ := d["owner_references"].([]map[string]interface{}); len(refs) != 1 || refs[0]["name"] != "owner" {
		t.Errorf("owner references %v", refs)
	}
	if f, _ := d["finalizers"].([]string); len(f) != 1 || f[0] != "numbers.kubeast.io/keep" {
		t.Errorf("finalizers %v", f)
	}
	var reasons []string
	events, _ := d["events"].([]map[string]interface{})
	for _, e := range events {
		reasons = append(reasons, e["reason"].(string))
	}
	if want := []string{"Ready", "Synced"}; !reflect.DeepEqual(reasons, want) {
		t.Errorf("events %v, want %v (newest first, this kind in this namespace)", reasons, want)
	}
	var asked []string
	for _, a := range api.asked {
		if strings.Contains(a, "/w1") || strings.Contains(a, "events") {
			asked = append(asked, a)
		}
	}
	want := []string{
		"/apis/numbers.kubeast.io/v1/namespaces/shop/widgets/w1?includeObject=Object " + tableAccept,
		"/api/v1/namespaces/shop/events?fieldSelector=involvedObject.name%3Dw1%2CinvolvedObject.kind%3DWidget",
	}
	if !reflect.DeepEqual(asked, want) {
		t.Errorf("asked %v, want %v", asked, want)
	}
}

// A cluster-scoped one is read by its own path and its events in every namespace; one that is gone is a 404.
func TestDescribeCustomResourceInstance_ClusterScopedAndGone(t *testing.T) {
	s, _ := newCRDescribeService(t)
	ctx := context.Background()
	d, err := s.DescribeCustomResourceInstance(ctx, "numbers.kubeast.io", "v1", "gadgets", "-", "g1")
	if err != nil {
		t.Fatal(err)
	}
	if printed, _ := d["printer_cells"].([]map[string]interface{}); d["namespace"] != "" || len(printed) != 5 {
		t.Errorf("g1: %v", d)
	}
	if ev, _ := d["events"].([]map[string]interface{}); len(ev) != 1 || ev[0]["reason"] != "Seen" {
		t.Errorf("g1 events (every namespace): %v", ev)
	}
	if _, err := s.DescribeCustomResourceInstance(ctx, "numbers.kubeast.io", "v1", "widgets", "shop", "gone"); !apierrors.IsNotFound(err) {
		t.Errorf("a gone object: %v, want NotFound", err)
	}
}
