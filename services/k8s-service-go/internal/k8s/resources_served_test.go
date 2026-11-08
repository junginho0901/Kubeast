package k8s

import (
	"context"
	"sync"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	fakediscovery "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// Re-QA #37: a Gateway API or VPA list on a cluster without the CRD is "not
// installed", told apart from "none" and "no permission" by discovery.
func TestResourceServed(t *testing.T) {
	s := &Service{
		apiResourcesCache: map[cluster.ID][]metav1.APIResourceList{
			"self": {
				{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods"}}},
				{GroupVersion: "gateway.networking.k8s.io/v1", APIResources: []metav1.APIResource{{Name: "gateways"}, {Name: "httproutes"}}},
				{GroupVersion: "gateway.networking.k8s.io/v1beta1", APIResources: []metav1.APIResource{{Name: "referencegrants"}}},
			},
		},
		apiResourcesAt: map[cluster.ID]time.Time{"self": time.Now()},
	}
	ctx := cluster.WithID(context.Background(), "self")
	for _, c := range []struct {
		group, resource string
		want            bool
	}{
		{"gateway.networking.k8s.io", "httproutes", true},
		{"gateway.networking.k8s.io", "referencegrants", true}, // any version
		{"gateway.networking.k8s.io", "grpcroutes", false},
		{"autoscaling.k8s.io", "verticalpodautoscalers", false},
		{"", "pods", true},
		{"apps", "pods", false}, // the group must match too
	} {
		if got := s.ResourceServed(ctx, c.group, c.resource); got != c.want {
			t.Errorf("ResourceServed(%q, %q) = %v, want %v", c.group, c.resource, got, c.want)
		}
	}
}

// A type the lists read earlier do not have may be a CRD created since: it is asked of the cluster again, as kubectl's
// discovery mapper asks again on a miss, once the lists are a second old, and requests at once for a type no API serves
// read discovery once.
func TestATypeTheListsDoNotHaveIsAskedAgain(t *testing.T) {
	disc := fake.NewSimpleClientset().Discovery().(*fakediscovery.FakeDiscovery)
	disc.Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "configmaps", Kind: "ConfigMap", Namespaced: true}}},
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{discovery: disc})
	ctx := context.Background() // the default cluster's bundle
	reads := func() int {
		n := 0
		for _, a := range disc.Actions() {
			if a.GetResource().Resource == "resource" {
				n++
			}
		}
		return n
	}
	readBefore := func(d time.Duration) {
		s.apiResourcesMu.Lock()
		s.apiResourcesRead[ctxClusterID(ctx)] = time.Now().Add(-d)
		s.apiResourcesMu.Unlock()
	}

	if _, _, err := s.ResolveResource(ctx, "configmaps"); err != nil || reads() != 1 {
		t.Fatalf("first resolve: %v, %d reads", err, reads())
	}
	disc.Resources = append(disc.Resources,
		&metav1.APIResourceList{GroupVersion: "e2e.kubeast.io/v1", APIResources: []metav1.APIResource{
			{Name: "widgets", Kind: "Widget", Namespaced: true},
			{Name: "gizmos", Kind: "Gizmo", Namespaced: false},
		}})

	if _, _, err := s.ResolveResource(ctx, "widgets.e2e.kubeast.io"); err == nil || reads() != 1 {
		t.Fatalf("lists read just now: %v, %d reads, want the miss and no read", err, reads())
	}
	readBefore(2 * time.Second)
	if gvr, namespaced, err := s.ResolveResource(ctx, "widgets.e2e.kubeast.io"); err != nil || gvr.Version != "v1" || !namespaced || reads() != 2 {
		t.Fatalf("a CRD created since the lists were read: %v %v %v, %d reads", gvr, namespaced, err, reads())
	}
	if kind, err := s.ResourceKind(ctx, "configmaps"); err != nil || kind != "ConfigMap" || reads() != 2 {
		t.Fatalf("a listed type: %q %v, %d reads, want no read", kind, err, reads())
	}

	disc.Resources[1].APIResources = append(disc.Resources[1].APIResources, metav1.APIResource{Name: "sprockets", Kind: "Sprocket", Namespaced: true})
	readBefore(2 * time.Second)
	if gvr, namespaced, err := s.ResolveKind(ctx, "e2e.kubeast.io/v1", "Sprocket"); err != nil || gvr.Resource != "sprockets" || !namespaced || reads() != 3 {
		t.Fatalf("a kind of a document to create: %v %v %v, %d reads", gvr, namespaced, err, reads())
	}

	readBefore(2 * time.Second)
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := s.ResolveResource(ctx, "nothings"); err == nil {
				t.Error("a type no API serves resolved")
			}
		}()
	}
	wg.Wait()
	if reads() != 4 {
		t.Fatalf("20 requests for a type no API serves: %d reads, want one more than 3", reads())
	}
}
