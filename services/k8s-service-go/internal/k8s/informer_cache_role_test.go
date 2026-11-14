package k8s

import (
	"context"
	"testing"

	"k8s.io/client-go/kubernetes/fake"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// A server of role "stream" serves no list: its bundles start no overview informers, and what reads them lists instead.
func TestNoInformersBundlesStartNone(t *testing.T) {
	t.Cleanup(func() { informersOff = false })
	reg := &mockRegistry{def: "a", clusters: map[cluster.ID]cluster.Info{"a": extCluster("a")}}
	s, err := NewService(context.Background(), reg, false, nil, ServiceOptions{MaxClusters: 20, NoInformers: true})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	b, err := s.For(context.Background(), "a")
	if err != nil {
		t.Fatalf("For: %v", err)
	}
	if b.cacheClient == nil {
		t.Fatal("the bundle lost its cache client: the events and the node's pods read through it")
	}
	if ci := b.overviewInformers(); ci != nil {
		ci.stopNow()
		t.Fatal("informers started on a bundle that keeps none")
	}

	on := &clientBundle{cacheClient: fake.NewSimpleClientset(overviewObjects()...)}
	t.Cleanup(func() { _ = on.Close() })
	if on.overviewInformers() == nil {
		t.Fatal("a bundle of the other roles starts its informers on first use")
	}
}
