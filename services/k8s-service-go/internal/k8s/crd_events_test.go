package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// The CRD drawer lists the events kubectl describe lists about it — its name and kind, in every namespace, a CRD being
// cluster-scoped — and its subresources by name, the order kubectl describe prints them, on every read (they were in
// a map's order).
func TestDescribeCRD_EventsAndSubresourcesInOrder(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	const name = "widgets.numbers.kubeast.io"
	crd := map[string]interface{}{
		"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
		"metadata": map[string]interface{}{"name": name, "uid": "u-crd", "resourceVersion": "9", "creationTimestamp": "2026-11-01T00:00:00Z"},
		"spec": map[string]interface{}{
			"group": "numbers.kubeast.io", "scope": "Namespaced",
			"names": map[string]interface{}{"kind": "Widget", "plural": "widgets", "singular": "widget", "listKind": "WidgetList"},
			"versions": []interface{}{
				map[string]interface{}{"name": "v1", "served": true, "storage": true, "subresources": map[string]interface{}{
					"status": map[string]interface{}{},
					"scale":  map[string]interface{}{"specReplicasPath": ".spec.replicas", "statusReplicasPath": ".status.replicas"},
				}},
				map[string]interface{}{"name": "v1beta1", "served": true, "storage": false, "subresources": map[string]interface{}{"status": map[string]interface{}{}}},
			},
		},
	}
	api := &clusterDrawersAPI{
		objects: map[string]interface{}{"/apis/apiextensions.k8s.io/v1/customresourcedefinitions/" + name: crd},
		events: []corev1.Event{
			gatewayEvent("default", "CustomResourceDefinition", name, "Established", now.Add(-5*time.Minute)),
			gatewayEvent("kube-system", "CustomResourceDefinition", name, "NamesAccepted", now.Add(-time.Minute)),
			gatewayEvent("default", "Widget", name, "OtherKind", now),
			gatewayEvent("default", "CustomResourceDefinition", "gadgets.numbers.kubeast.io", "OtherName", now),
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(srv.Close)
	// no client rate limit: a hundred reads, so a map's order shows
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	dyn, err := dynamic.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs, dynamic: dyn})

	ctx := context.Background()
	for i := 0; i < 100; i++ {
		d, err := s.DescribeCRD(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		if got := d["subresources"]; !reflect.DeepEqual(got, []string{"scale", "status"}) {
			t.Fatalf("read %d: subresources %v, want [scale status]", i+1, got)
		}
		if i == 0 {
			if got := reasons(d); !reflect.DeepEqual(got, []string{"NamesAccepted", "Established"}) {
				t.Errorf("events %v, want [NamesAccepted Established] (this CRD's, newest first, every namespace)", got)
			}
		}
	}

	// events refused: the drawer still opens, with no events
	api.refuseEvents = true
	d, err := s.DescribeCRD(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	if got := reasons(d); len(got) != 0 {
		t.Errorf("events refused: %v, want none", got)
	}
}

// The Timeline names each event's object with its apiVersion, so the page opens a custom resource of the right group.
func TestTimelineEventRow_NamesTheObjectsAPIVersion(t *testing.T) {
	last := time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC)
	e := gatewayEvent("shop", "Widget", "w1", "Synced", last)
	e.InvolvedObject.APIVersion = "numbers.kubeast.io/v1"
	e.Source.Component = "widget-controller"
	row := timelineEventRow(&e)
	want := map[string]interface{}{"kind": "Widget", "name": "w1", "namespace": "shop", "api_version": "numbers.kubeast.io/v1"}
	for _, k := range []string{"resource", "involved_object"} {
		if got, _ := row[k].(map[string]interface{}); !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %v, want %v", k, got, want)
		}
	}
	for k, v := range map[string]interface{}{
		"timestamp": "2026-11-04T09:00:00Z", "type": "Normal", "reason": "Synced", "message": "Synced by the controller",
		"source": "widget-controller", "count": int32(1), "first_seen": "2026-11-04T09:00:00Z", "last_seen": "2026-11-04T09:00:00Z",
	} {
		if row[k] != v {
			t.Errorf("%s = %v (%T), want %v", k, row[k], row[k], v)
		}
	}
}
