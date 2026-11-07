package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	fakediscovery "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
)

const oneEvent = `{"kind":"EventList","apiVersion":"v1","metadata":{},"items":[{"metadata":{"name":"e1"},"type":"Normal","reason":"Seen","message":"seen","count":1}]}`

const eventsForbidden = `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403,"message":"events is forbidden"}`

// The DRA drawers list the events kubectl describe's generic describer lists: by the object's name and kind, in its
// namespace, and across namespaces for a cluster-scoped kind.
func TestDRADescribe_EventsOfTheObject(t *testing.T) {
	ctx := context.Background()
	for _, c := range []struct {
		kind, path, selector string
		describe             func(s *Service) (map[string]interface{}, error)
	}{
		{"DeviceClass", "/api/v1/events", "involvedObject.name=gpu.example.com,involvedObject.kind=DeviceClass",
			func(s *Service) (map[string]interface{}, error) { return s.DescribeDeviceClass(ctx, "gpu.example.com") }},
		{"ResourceSlice", "/api/v1/events", "involvedObject.name=s1,involvedObject.kind=ResourceSlice",
			func(s *Service) (map[string]interface{}, error) { return s.DescribeResourceSlice(ctx, "s1") }},
		{"ResourceClaim", "/api/v1/namespaces/ml/events", "involvedObject.name=p-gpu-x7k2q,involvedObject.kind=ResourceClaim",
			func(s *Service) (map[string]interface{}, error) {
				return s.DescribeResourceClaim(ctx, "ml", "p-gpu-x7k2q")
			}},
		{"ResourceClaimTemplate", "/api/v1/namespaces/ml/events", "involvedObject.name=one-gpu,involvedObject.kind=ResourceClaimTemplate",
			func(s *Service) (map[string]interface{}, error) {
				return s.DescribeResourceClaimTemplate(ctx, "ml", "one-gpu")
			}},
	} {
		t.Run(c.kind, func(t *testing.T) {
			var path, selector string
			s, _ := newDRAServiceWithEvents(t, func(w http.ResponseWriter, r *http.Request) {
				path, selector = r.URL.Path, r.URL.Query().Get("fieldSelector")
				_, _ = w.Write([]byte(oneEvent))
			})
			out, err := c.describe(s)
			if err != nil {
				t.Fatal(err)
			}
			if path != c.path || selector != c.selector {
				t.Errorf("asked %s?fieldSelector=%s, want %s?fieldSelector=%s", path, selector, c.path, c.selector)
			}
			if got := reasons(out); !reflect.DeepEqual(got, []string{"Seen"}) {
				t.Errorf("events %v (answer %v), want Seen", got, out["events"])
			}

			refused, _ := newDRAServiceWithEvents(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(eventsForbidden))
			})
			out, err = c.describe(refused)
			if err != nil {
				t.Fatal(err)
			}
			if _, has := out["events"]; has || out["events_error"] != "events is forbidden" {
				t.Errorf("refused: events %#v, events_error %#v — want the reason and no list", out["events"], out["events_error"])
			}
		})
	}
}

// genericDescribeFake serves one namespaced kind and one cluster-scoped kind of a group Kubeast has no view for.
func genericDescribeFake(t *testing.T, events http.HandlerFunc) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/events", "/api/v1/namespaces/ns/events":
			events(w, r)
		case "/apis/example.com/v1/namespaces/ns/gadgets/g1":
			_, _ = w.Write([]byte(`{"apiVersion":"example.com/v1","kind":"Gadget","metadata":{"name":"g1","namespace":"ns"}}`))
		case "/apis/example.com/v1/racks/r1":
			_, _ = w.Write([]byte(`{"apiVersion":"example.com/v1","kind":"Rack","metadata":{"name":"r1"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		}
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
	disc := fake.NewSimpleClientset().Discovery().(*fakediscovery.FakeDiscovery)
	disc.Resources = []*metav1.APIResourceList{{GroupVersion: "example.com/v1", APIResources: []metav1.APIResource{
		{Name: "gadgets", SingularName: "gadget", Kind: "Gadget", Namespaced: true},
		{Name: "racks", SingularName: "rack", Kind: "Rack", Namespaced: false},
	}}}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs, dynamic: dyn, discovery: disc})
	return s
}

// The fallback drawer lists the events too: the object's kind as the object says, its namespace, every namespace for a
// cluster-scoped one; refused, the reason and no list.
func TestDescribeGenericResource_EventsOfTheObject(t *testing.T) {
	ctx := context.Background()
	for _, c := range []struct {
		resource, namespace, name, path, selector string
	}{
		{"gadgets.example.com", "ns", "g1", "/api/v1/namespaces/ns/events", "involvedObject.name=g1,involvedObject.kind=Gadget"},
		{"racks.example.com", "", "r1", "/api/v1/events", "involvedObject.name=r1,involvedObject.kind=Rack"},
	} {
		var path, selector string
		s := genericDescribeFake(t, func(w http.ResponseWriter, r *http.Request) {
			path, selector = r.URL.Path, r.URL.Query().Get("fieldSelector")
			_, _ = w.Write([]byte(oneEvent))
		})
		out, err := s.DescribeGenericResource(ctx, c.resource, c.namespace, c.name)
		if err != nil {
			t.Fatal(err)
		}
		if path != c.path || selector != c.selector {
			t.Errorf("%s: asked %s?fieldSelector=%s, want %s?fieldSelector=%s", c.resource, path, selector, c.path, c.selector)
		}
		if got := reasons(out); !reflect.DeepEqual(got, []string{"Seen"}) {
			t.Errorf("%s: events %v, want Seen", c.resource, got)
		}
	}
	refused := genericDescribeFake(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(eventsForbidden))
	})
	out, err := refused.DescribeGenericResource(ctx, "gadgets.example.com", "ns", "g1")
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := json.Marshal(out["events_error"]); string(b) != `"events is forbidden"` || out["events"] != nil {
		t.Errorf("refused: events %#v, events_error %s", out["events"], b)
	}
}
