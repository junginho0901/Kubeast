package k8s

import (
	"errors"
	"fmt"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
)

// The answers that decide what a caller sees of the reads made as kubeast:cache come from the cluster to this process:
// an entry of the same name in the shared cache decides nothing, the answers are not written there, and an answer
// asked again within its minute is not asked of the cluster again.
func TestAccessAnswersComeFromTheClusterNotTheSharedCache(t *testing.T) {
	api := &reviewAPI{allow: func(string, []string, authorizationv1.ResourceAttributes) bool { return false }}
	b := api.bundle(t)
	s := &Service{cache: cache.New("", 0, 0, "")}
	ctx := callerCtx("bob")
	for _, question := range []string{"pods_list_allowed:", "nodes_list_allowed:", "apps/deployments_list_allowed:"} {
		s.cache.Set(ctx, s.clusterCacheKey(ctx, question), true, time.Minute)
	}
	ci := overviewInformersWithPods(t)

	ask := func(round string) {
		t.Helper()
		if all, namespaces, err := s.podListAccess(ctx, b, ""); !errors.Is(err, errPodsForbidden) {
			t.Errorf("%s: pods page access = %v %v %v, want the cluster's refusal", round, all, namespaces, err)
		}
		if ok, err := s.mayList(ctx, b, "nodes", ""); ok || err != nil {
			t.Errorf("%s: node list access = %v %v, want the cluster's refusal", round, ok, err)
		}
		ov := ci.overviewFor(nil)
		if err := s.keepListable(ctx, b, ci, nil, ov); err != nil {
			t.Fatal(err)
		}
		if refused, _ := ov["refused"].([]string); len(refused) != len(overviewCounts) {
			t.Errorf("%s: overview refused %v, want every count", round, refused)
		}
	}
	ask("first")
	asked := api.count("bob")
	if asked != len(overviewCounts) {
		t.Errorf("the cluster was asked %d questions, want one per kind (%d)", asked, len(overviewCounts))
	}
	ask("again")
	if got := api.count("bob"); got != asked {
		t.Errorf("asked again within the minute: %d more questions to the cluster, want none", got-asked)
	}
	var written bool
	if s.cache.Peek(ctx, s.clusterCacheKey(ctx, "services_list_allowed:"), &written) {
		t.Errorf("an answer was written to the shared cache: %v", written)
	}
}

// An answer ends at its end, and many questions of the last minute stay while ended ones go.
func TestAccessAnswersEndAndDoNotPileUp(t *testing.T) {
	var a accessAnswers
	now := time.Now()
	a.set("live", true, now.Add(time.Minute))
	a.set("ended", true, now.Add(-time.Millisecond))
	if allowed, ok := a.get("live", now); !ok || !allowed {
		t.Fatalf("live answer = %v %v", allowed, ok)
	}
	if _, ok := a.get("ended", now); ok {
		t.Fatal("an ended answer was given")
	}
	for i := range 5000 {
		a.set(fmt.Sprintf("old-%d", i), false, now.Add(-time.Millisecond))
	}
	a.mu.RLock()
	n := len(a.kept)
	a.mu.RUnlock()
	if n > 2*accessAnswersSweepMin {
		t.Errorf("%d answers kept, most of them ended", n)
	}
	if allowed, ok := a.get("live", time.Now()); !ok || !allowed {
		t.Fatalf("the live answer went with the ended ones: %v %v", allowed, ok)
	}
}
