package k8s

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func policyReportCacheOfTest(t *testing.T) (context.Context, *policyReportCache) {
	t.Helper()
	id := fmt.Sprintf("polr-cache-%s", t.Name())
	return cluster.WithID(context.Background(), cluster.ID(id)), policyReportCacheFor(id)
}

// An answer past its minute goes when another comes in, so the cache does not keep every identity and namespace it has
// ever read; an answer still fresh stays.
func TestPolicyReportCacheDropsWhatHasExpiredWhenItKeepsAnAnswer(t *testing.T) {
	ctx, c := policyReportCacheOfTest(t)
	s := &Service{}
	c.mu.Lock()
	for i := 0; i < 100; i++ {
		c.sets[fmt.Sprintf("old-%d|as:x", i)] = policyReportSet{at: time.Now().Add(-2 * policyReportCacheTTL)}
	}
	c.sets["fresh|as:x"] = policyReportSet{at: time.Now()}
	c.mu.Unlock()

	read := func(context.Context) (policyReportSet, error) { return policyReportSet{at: time.Now()}, nil }
	if _, err := s.cachedPolicyReports(ctx, "new", false, read); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	t.Logf("answers kept after one insert: %d", len(c.sets))
	if len(c.sets) != 2 {
		t.Errorf("%d answers kept, want the fresh one and the new one", len(c.sets))
	}
	if _, ok := c.sets["fresh|as:x"]; !ok {
		t.Error("a fresh answer was dropped")
	}
}

// One identity reading one view at one moment reads it once; every answer is that read's.
func TestPolicyReportReadsOfOneCallerAtOnceReadOnce(t *testing.T) {
	ctx, _ := policyReportCacheOfTest(t)
	ctx = auth.WithPayload(ctx, auth.TokenPayload{UserID: "alice", Email: "alice"})
	s := &Service{}
	var reads atomic.Int64
	read := func(context.Context) (policyReportSet, error) {
		reads.Add(1)
		time.Sleep(30 * time.Millisecond)
		return policyReportSet{at: time.Now(), results: []PolicyReportResult{{Name: "r"}}}, nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			set, err := s.cachedPolicyReports(ctx, "ns", false, read)
			if err != nil || len(set.results) != 1 {
				t.Errorf("answer: %+v %v", set, err)
			}
		}()
	}
	wg.Wait()
	t.Logf("reads for 30 requests at once: %d", reads.Load())
	if reads.Load() != 1 {
		t.Errorf("%d reads for 30 requests of one caller, want 1", reads.Load())
	}
}

// Each identity reads what it may see.
func TestPolicyReportReadsAreNotSharedBetweenIdentities(t *testing.T) {
	base, _ := policyReportCacheOfTest(t)
	s := &Service{}
	var wg sync.WaitGroup
	for _, user := range []string{"alice", "bob", "carol"} {
		ctx := auth.WithPayload(base, auth.TokenPayload{UserID: user, Email: user})
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				set, err := s.cachedPolicyReports(ctx, "ns", false, func(context.Context) (policyReportSet, error) {
					time.Sleep(10 * time.Millisecond)
					return policyReportSet{at: time.Now(), results: []PolicyReportResult{{Name: user}}}, nil
				})
				if err != nil || set.results[0].Name != user {
					t.Errorf("%s got %+v, %v", user, set.results, err)
				}
			}()
		}
	}
	wg.Wait()
}

// A forced read is what the cluster holds when it was asked for: one under way when it came does not answer it.
func TestAForcedPolicyReportReadIsNotAnsweredByAReadStartedBefore(t *testing.T) {
	ctx, _ := policyReportCacheOfTest(t)
	s := &Service{}
	started := make(chan struct{})
	release := make(chan struct{})
	first := make(chan policyReportSet, 1)
	go func() {
		set, _ := s.cachedPolicyReports(ctx, "ns", false, func(context.Context) (policyReportSet, error) {
			close(started)
			<-release
			return policyReportSet{at: time.Now(), results: []PolicyReportResult{{Name: "before"}}}, nil
		})
		first <- set
	}()
	<-started
	second := make(chan policyReportSet, 1)
	go func() {
		set, _ := s.cachedPolicyReports(ctx, "ns", true, func(context.Context) (policyReportSet, error) {
			return policyReportSet{at: time.Now(), results: []PolicyReportResult{{Name: "after"}}}, nil
		})
		second <- set
	}()
	time.Sleep(20 * time.Millisecond)
	close(release)
	<-first
	if got := <-second; got.results[0].Name != "after" {
		t.Errorf("a forced read got %q", got.results[0].Name)
	}
}

// A failed read is not kept, and a read after it asks again.
func TestAFailedPolicyReportReadIsNotKept(t *testing.T) {
	ctx, _ := policyReportCacheOfTest(t)
	s := &Service{}
	if _, err := s.cachedPolicyReports(ctx, "ns", false, func(context.Context) (policyReportSet, error) {
		return policyReportSet{}, fmt.Errorf("refused")
	}); err == nil {
		t.Fatal("no error")
	}
	set, err := s.cachedPolicyReports(ctx, "ns", false, func(context.Context) (policyReportSet, error) {
		return policyReportSet{at: time.Now(), results: []PolicyReportResult{{Name: "ok"}}}, nil
	})
	if err != nil || set.results[0].Name != "ok" {
		t.Fatalf("after a failure: %+v, %v", set, err)
	}
}
