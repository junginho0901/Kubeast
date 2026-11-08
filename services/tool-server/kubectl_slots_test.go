package main

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// countingKubectl stands in for kubectl and counts the runs under way; each waits for release when one is given.
func countingKubectl(t *testing.T, delay time.Duration, release chan struct{}) (most, started *atomic.Int64) {
	t.Helper()
	orig := kubectlExec
	most, started = &atomic.Int64{}, &atomic.Int64{}
	var running atomic.Int64
	kubectlExec = func(ctx context.Context, _ []string, _ *string) ([]byte, error) {
		started.Add(1)
		n := running.Add(1)
		defer running.Add(-1)
		for {
			m := most.Load()
			if n <= m || most.CompareAndSwap(m, n) {
				break
			}
		}
		time.Sleep(delay)
		if release != nil {
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return []byte("ok"), nil
	}
	t.Cleanup(func() { kubectlExec = orig })
	return most, started
}

// Twenty people's AI tools at once run kubectl a few at a time, 40 MiB each in one container of 256 Mi, and all of them
// get their answer.
func TestKubectlRunsTakeTurnsAndAllAnswer(t *testing.T) {
	most, started := countingKubectl(t, 5*time.Millisecond, nil)
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := runKubectl(context.Background(), nil, "get", "pods")
			if err != nil || out != "ok" {
				t.Errorf("run %d: %q, %v", i, out, err)
			}
		}()
	}
	wg.Wait()
	t.Logf("kubectl at once: %d, for 30 runs", most.Load())
	if most.Load() > 3 {
		t.Errorf("%d kubectl at once, want at most 3", most.Load())
	}
	if started.Load() != 30 {
		t.Errorf("%d of 30 runs started", started.Load())
	}
}

// Every way to run kubectl takes its turn.
func TestEveryKubectlPathTakesATurn(t *testing.T) {
	most, _ := countingKubectl(t, 5*time.Millisecond, nil)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		for _, run := range []func(){
			func() { _, _ = runKubectl(context.Background(), nil, "get", "pods") },
			func() { _, _ = runKubectlWithInput(context.Background(), nil, "input", "apply", "-f", "-") },
			func() { _, _, _ = runKubectlKeepingEnd(context.Background(), "logs", "p") },
			func() { _, _ = gitopsRead(context.Background(), "get", "pods") },
		} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				run()
			}()
		}
	}
	wg.Wait()
	t.Logf("kubectl at once: %d, for 32 runs of four kinds", most.Load())
	if most.Load() > 3 {
		t.Errorf("%d kubectl at once, want at most 3", most.Load())
	}
}

// A call whose time runs out while waiting says so, and starts nothing.
func TestAWaitingKubectlEndsWithItsCallAndSaysWhy(t *testing.T) {
	release := make(chan struct{})
	_, started := countingKubectl(t, 0, release)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = runKubectl(context.Background(), nil, "get", "pods")
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for started.Load() < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("%d runs started", started.Load())
		}
		time.Sleep(time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := runKubectl(ctx, nil, "get", "pods")
	if err == nil || !strings.Contains(err.Error(), "kubectl") || !strings.Contains(err.Error(), "under way") {
		t.Errorf("the run that waited: %v", err)
	}
	if started.Load() != 3 {
		t.Errorf("%d runs started with three under way", started.Load())
	}
	close(release)
	wg.Wait()
}

// The memory a run needs is set aside from the collector's limit: kubectl's memory counts in the same container.
func TestKubectlMemoryIsReservedPerPlace(t *testing.T) {
	if got := kubectlReservedBytes(3); got != 120<<20 {
		t.Errorf("reserved %d bytes for three runs, want 120 MiB", got)
	}
}
