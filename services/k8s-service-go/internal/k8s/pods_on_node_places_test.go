package k8s

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
)

func (a *clusterAPI) cacheReads() (now, most int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cacheNow, a.cacheMost
}

// manyNodes is two pods on each of n nodes and a caller per node who may list pods everywhere.
func manyNodes(n int) ([]corev1.Pod, map[string][]string) {
	var pods []corev1.Pod
	grants := map[string][]string{}
	for i := 0; i < n; i++ {
		node := fmt.Sprintf("n%02d", i)
		pods = append(pods, nodePod("a", "a-"+node, node), nodePod("b", "b-"+node, node))
		grants[fmt.Sprintf("u%02d@example.com", i)] = []string{""}
	}
	return pods, grants
}

// openNodes asks for node i's pods as caller i for each i in from..to-1 and returns their answers once release has
// closed and all are in.
func openNodes(s *Service, from, to int) (wait func() ([][]map[string]interface{}, []error)) {
	answers := make([][]map[string]interface{}, to-from)
	errs := make([]error, to-from)
	var wg sync.WaitGroup
	for i := from; i < to; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i-from], errs[i-from] = s.GetPodsOnNode(wideCaller(fmt.Sprintf("u%02d@example.com", i)), fmt.Sprintf("n%02d", i), "")
		}()
	}
	return func() ([][]map[string]interface{}, []error) {
		wg.Wait()
		return answers, errs
	}
}

// Sixty people opening sixty different nodes' boxes at one moment are read sixteen nodes at a time, and each gets what
// its own list shows.
func TestPodsOnNodeOfManyNodesAreReadAFewAtATime(t *testing.T) {
	pods, grants := manyNodes(60)
	api := &clusterAPI{pods: pods, review: rbac(grants), holdCache: make(chan struct{})}
	s, b := api.start(t)
	wait := openNodes(s, 0, 60)
	eventually(t, 5*time.Second, func() bool { now, _ := api.cacheReads(); return now >= 16 })
	time.Sleep(300 * time.Millisecond)
	_, most := api.cacheReads()
	close(api.holdCache)
	answers, errs := wait()
	t.Logf("60 nodes at once: %d read as %s at the same time", most, overviewCacheUser)
	if most > 16 {
		t.Errorf("%d node reads at once, want at most 16", most)
	}
	for i, got := range answers {
		caller := wideCaller(fmt.Sprintf("u%02d@example.com", i))
		want, err := listPodsOnNode(caller, b.clientset.CoreV1(), fmt.Sprintf("n%02d", i), nil)
		if errs[i] != nil || err != nil || len(want) != 2 || answerJSON(t, got) != answerJSON(t, want) {
			t.Errorf("node %d: %d pods, %v; the caller's own list %d, %v", i, len(got), errs[i], len(want), err)
		}
	}
}

// A caller that leaves while every node read is taken reads nothing and gets its request's end.
func TestPodsOnNodeACallerWaitingForANodeReadLeavesWithItsRequest(t *testing.T) {
	pods, grants := manyNodes(17)
	api := &clusterAPI{pods: pods, review: rbac(grants), holdCache: make(chan struct{})}
	s, _ := api.start(t)
	wait := openNodes(s, 0, 16)
	defer func() { close(api.holdCache); wait() }()
	if !eventually(t, 5*time.Second, func() bool { now, _ := api.cacheReads(); return now >= 16 }) {
		t.Fatal("the sixteen reads never started")
	}
	ctx, cancel := context.WithTimeout(wideCaller("u16@example.com"), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := s.GetPodsOnNode(ctx, "n16", "")
	took := time.Since(start)
	read := api.count(func(c apiCall) bool { return c.user == overviewCacheUser && c.selector == "spec.nodeName=n16" })
	if !errors.Is(err, context.DeadlineExceeded) || took > 2*time.Second || read != 0 {
		t.Errorf("the caller who left: %v after %v, its node read %d times", err, took, read)
	}
}

// One cluster's node reads all taken keep no other cluster's caller waiting.
func TestPodsOnNodeOfOneClusterWaitForNoOtherCluster(t *testing.T) {
	pods, grants := manyNodes(16)
	busy := &clusterAPI{pods: pods, review: rbac(grants), holdCache: make(chan struct{})}
	s, _ := busy.start(t)
	wait := openNodes(s, 0, 16)
	defer func() { close(busy.holdCache); wait() }()
	if !eventually(t, 5*time.Second, func() bool { now, _ := busy.cacheReads(); return now >= 16 }) {
		t.Fatal("the sixteen reads never started")
	}
	other := &clusterAPI{pods: podsOnNodes(), review: rbac(map[string][]string{"wide@example.com": {""}})}
	otherService, otherBundle := other.start(t)
	otherBundle.id = "other"
	ctx, cancel := context.WithTimeout(wideCaller("wide@example.com"), 2*time.Second)
	defer cancel()
	got, err := otherService.GetPodsOnNode(ctx, "n1", "")
	if err != nil || len(got) != 6 {
		t.Errorf("the other cluster's node: %d pods, %v", len(got), err)
	}
}
