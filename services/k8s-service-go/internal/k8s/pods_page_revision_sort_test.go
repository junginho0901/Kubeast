package k8s

import (
	"context"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes/fake"
)

// A poll that sorts by health sends its revision like any other, and is answered before anything is sorted.
func TestGetPodPage_RevisionHoldsForASortedPage(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewSimpleClientset(pagePods()...)
	s, b, _ := pageBundle(t, cs, func(string) bool { return true })
	query := PodPageQuery{Sort: "health", Limit: 10}
	if _, err := s.GetPodPage(ctx, query); err != nil {
		t.Fatal(err)
	}
	ci := b.syncedInformers()
	var last string
	eventually(t, 2*time.Second, func() bool { // the handler runs after the store; wait for it to catch up
		cur := ci.podRevision()
		done := cur == last
		last = cur
		time.Sleep(50 * time.Millisecond)
		return done
	})
	first, err := s.GetPodPage(ctx, query)
	if err != nil || len(first.Items) == 0 {
		t.Fatalf("first page: %+v %v", first, err)
	}
	query.Revision = first.Revision
	again, err := s.GetPodPage(ctx, query)
	if err != nil || !again.Unchanged || len(again.Items) != 0 || again.Revision != first.Revision {
		t.Fatalf("same revision: %+v %v", again, err)
	}

	// The other screens that poll ask with these: the Dashboard's Pods window, its namespaces' counts, a drawer's pods.
	for name, other := range map[string]PodPageQuery{
		"a phase":           {Phase: "Running", Limit: 50},
		"a search":          {Search: "web", Limit: 50},
		"the groups":        {Limit: 1, Groups: true, GroupTop: 20},
		"a service account": {ServiceAccounts: []string{"demo/default"}, Limit: 10},
		"a priority class":  {PriorityClass: "demo-high", Limit: 10},
		"a runtime class":   {RuntimeClass: "demo-kata", Limit: 10},
	} {
		other.Revision = first.Revision
		answer, err := s.GetPodPage(ctx, other)
		if err != nil || !answer.Unchanged || len(answer.Items) != 0 || answer.Revision != first.Revision {
			t.Errorf("%s with the same revision: %+v %v", name, answer, err)
		}
	}
}
