package k8s

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/discovery"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// heldDiscovery answers discovery with one list of pods, after hold is closed when it is set, and counts the reads.
type heldDiscovery struct {
	discovery.DiscoveryInterface
	hold  chan struct{}
	reads atomic.Int64
}

func (d *heldDiscovery) ServerGroupsAndResources() ([]*metav1.APIGroup, []*metav1.APIResourceList, error) {
	d.reads.Add(1)
	if d.hold != nil {
		<-d.hold
	}
	return nil, []*metav1.APIResourceList{{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true}}}}, nil
}

// A cluster whose discovery is slow to answer keeps no other cluster's request waiting: requests of every cluster read
// the API resources a second at a time when they name a type the lists lack.
func TestOneClustersSlowDiscoveryKeepsNoOtherClusterWaiting(t *testing.T) {
	reg := &mockRegistry{def: "quick", clusters: map[cluster.ID]cluster.Info{"quick": extCluster("quick"), "slow": extCluster("slow")}}
	s := newTestService(t, reg)
	quick, slow := &heldDiscovery{}, &heldDiscovery{hold: make(chan struct{})}
	s.pool().Add("quick", &clientBundle{id: "quick", discovery: quick})
	s.pool().Add("slow", &clientBundle{id: "slow", discovery: slow})
	quickCtx, slowCtx := cluster.WithID(context.Background(), "quick"), cluster.WithID(context.Background(), "slow")
	if _, err := s.GetAPIResources(quickCtx); err != nil {
		t.Fatal(err)
	}

	slowDone := make(chan error, 1)
	go func() {
		_, err := s.GetAPIResources(slowCtx)
		slowDone <- err
	}()
	if !eventually(t, 5*time.Second, func() bool { return slow.reads.Load() == 1 }) {
		t.Fatal("the slow cluster's discovery never started")
	}

	answered := make(chan time.Duration, 1)
	start := time.Now()
	go func() {
		_, _ = s.GetAPIResources(quickCtx)
		answered <- time.Since(start)
	}()
	waited := false
	select {
	case took := <-answered:
		t.Logf("the other cluster's lists, read before, answered in %v", took)
	case <-time.After(2 * time.Second):
		waited = true
		t.Errorf("the other cluster's lists, read a moment before, waited past 2s for the slow cluster's discovery")
	}
	close(slow.hold)
	if err := <-slowDone; err != nil {
		t.Errorf("slow cluster: %v", err)
	}
	if waited {
		<-answered
	}

	// requests of one cluster that come during its read wait for that read and read nothing more
	slow.hold = make(chan struct{})
	s.invalidateCaches()
	before := slow.reads.Load()
	errs := make(chan error, 10)
	for range 10 {
		go func() {
			_, err := s.GetAPIResources(slowCtx)
			errs <- err
		}()
	}
	eventually(t, 5*time.Second, func() bool { return slow.reads.Load() > before })
	time.Sleep(100 * time.Millisecond)
	close(slow.hold)
	for range 10 {
		if err := <-errs; err != nil {
			t.Errorf("slow cluster: %v", err)
		}
	}
	if got := slow.reads.Load() - before; got != 1 {
		t.Errorf("10 requests during one read read discovery %d times, want 1", got)
	}
}
