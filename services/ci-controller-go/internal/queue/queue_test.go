package queue

import (
	"errors"
	"fmt"
	"math/rand"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC)

func build(i int, repo, ref, sha string) Build {
	return Build{ID: fmt.Sprintf("b%03d", i), Repo: repo, Ref: ref, SHA: sha, Enqueued: t0.Add(time.Duration(i) * time.Second)}
}

func ids(bs []Build) string {
	var s []string
	for _, b := range bs {
		s = append(s, b.ID)
	}
	return strings.Join(s, ",")
}

func mustNew(t testing.TB, s Settings) *Queue {
	t.Helper()
	q, err := New(s)
	if err != nil {
		t.Fatal(err)
	}
	return q
}

// TestPassLine is the CI design's pass line: 50 builds arriving at once
// run 10 and wait 40, and start in the order they came.
func TestPassLine(t *testing.T) {
	q := mustNew(t, Settings{})
	var started []Build
	for i := 0; i < 50; i++ {
		d, err := q.Submit(build(i, fmt.Sprintf("org/app%02d", i), "refs/heads/main", fmt.Sprintf("%040d", i)))
		if err != nil {
			t.Fatal(err)
		}
		started = append(started, d.Start...)
	}
	running, waiting := q.Snapshot()
	if len(running) != 10 || len(waiting) != 40 {
		t.Fatalf("%d running, %d waiting; want 10 and 40", len(running), len(waiting))
	}
	if ids(started) != "b000,b001,b002,b003,b004,b005,b006,b007,b008,b009" {
		t.Fatalf("started %s", ids(started))
	}
	for i, w := range waiting {
		if want := fmt.Sprintf("b%03d", i+10); w.ID != want || q.Position(w.ID) != i+1 {
			t.Fatalf("waiting[%d] = %s at %d, want %s at %d", i, w.ID, q.Position(w.ID), want, i+1)
		}
	}
	for i := 0; i < 40; i++ {
		d := q.Finish(fmt.Sprintf("b%03d", i))
		if len(d.Start) != 1 || d.Start[0].ID != fmt.Sprintf("b%03d", i+10) {
			t.Fatalf("after b%03d finished, started %s", i, ids(d.Start))
		}
	}
}

func TestOneRepositoryCannotHoldEveryPlace(t *testing.T) {
	q := mustNew(t, Settings{})
	for i := 0; i < 20; i++ {
		q.Submit(build(i, "org/busy", fmt.Sprintf("refs/heads/f%d", i), "a"))
	}
	var started []Build
	for i := 20; i < 23; i++ {
		d, _ := q.Submit(build(i, "org/other", fmt.Sprintf("refs/heads/f%d", i), "b"))
		started = append(started, d.Start...)
	}
	running, waiting := q.Snapshot()
	if len(running) != 8 || ids(started) != "b020,b021,b022" || len(waiting) != 15 {
		t.Fatalf("%d running, started %s, %d waiting; want busy's 5 + other's 3", len(running), ids(started), len(waiting))
	}
	if q.Position("b005") != 1 {
		t.Fatalf("the first waiting busy build is at %d", q.Position("b005"))
	}
	// When a busy build finishes, the next busy build takes its place.
	if d := q.Finish("b000"); ids(d.Start) != "b005" {
		t.Fatalf("started %s, want b005", ids(d.Start))
	}
}

func TestNewerPushReplacesTheWaitingBuild(t *testing.T) {
	q := mustNew(t, Settings{MaxRunning: 1, MaxPerRepo: 1})
	q.Submit(build(0, "org/a", "refs/heads/x", "1"))
	q.Submit(build(1, "org/b", "refs/heads/y", "1"))
	d, err := q.Submit(build(2, "org/b", "refs/heads/y", "2"))
	if err != nil || ids(d.Replaced) != "b001" || len(d.Cancel) != 0 {
		t.Fatalf("%+v %v", d, err)
	}
	if _, waiting := q.Snapshot(); ids(waiting) != "b002" {
		t.Fatalf("waiting %s", ids(waiting))
	}
}

func TestNewerPushCancelsTheRunningBuild(t *testing.T) {
	q := mustNew(t, Settings{})
	q.Submit(build(0, "org/a", "refs/pull/7/head", "1"))
	d, _ := q.Submit(build(1, "org/a", "refs/pull/7/head", "2"))
	if ids(d.Cancel) != "b000" || ids(d.Start) != "b001" {
		t.Fatalf("cancel %s, start %s; want b000 cancelled and b001 started", ids(d.Cancel), ids(d.Start))
	}
	// The controller reports the cancelled build finished; nothing changes.
	if d := q.Finish("b000"); len(d.Start) != 0 {
		t.Fatalf("finishing the cancelled build started %s", ids(d.Start))
	}
}

func TestDefaultBranchKeepsItsRunningBuild(t *testing.T) {
	q := mustNew(t, Settings{})
	main := func(i int, sha string) Build {
		b := build(i, "org/a", "refs/heads/main", sha)
		b.DefaultBranch = true
		return b
	}
	q.Submit(main(0, "1"))
	d, _ := q.Submit(main(1, "2"))
	if len(d.Cancel) != 0 || len(d.Start) != 0 || q.Position("b001") != 1 {
		t.Fatalf("cancel %s, start %s, position %d; want the newer build waiting", ids(d.Cancel), ids(d.Start), q.Position("b001"))
	}
	// A third push replaces the waiting one, not the running one.
	d, _ = q.Submit(main(2, "3"))
	if ids(d.Replaced) != "b001" || len(d.Cancel) != 0 {
		t.Fatalf("%+v", d)
	}
	if d := q.Finish("b000"); ids(d.Start) != "b002" {
		t.Fatalf("after the running build, started %s", ids(d.Start))
	}

	q2 := mustNew(t, Settings{CancelDefaultBranch: true})
	q2.Submit(main(0, "1"))
	if d, _ := q2.Submit(main(1, "2")); ids(d.Cancel) != "b000" || ids(d.Start) != "b001" {
		t.Fatalf("CancelDefaultBranch: cancel %s, start %s", ids(d.Cancel), ids(d.Start))
	}
}

func TestKeepRunning(t *testing.T) {
	q := mustNew(t, Settings{KeepRunning: true})
	q.Submit(build(0, "org/a", "refs/heads/x", "1"))
	d, _ := q.Submit(build(1, "org/a", "refs/heads/x", "2"))
	if len(d.Cancel) != 0 || len(d.Start) != 0 {
		t.Fatalf("KeepRunning cancelled or started: %+v", d)
	}
}

func TestDuplicateCommit(t *testing.T) {
	q := mustNew(t, Settings{MaxRunning: 1, MaxPerRepo: 1})
	q.Submit(build(0, "org/a", "refs/heads/x", "1"))
	q.Submit(build(1, "org/b", "refs/heads/y", "1"))
	for _, b := range []Build{build(2, "org/a", "refs/heads/x", "1"), build(3, "org/b", "refs/heads/y", "1")} {
		if _, err := q.Submit(b); !errors.Is(err, ErrDuplicate) {
			t.Errorf("%s/%s again: %v", b.Repo, b.Ref, err)
		}
	}
	// The same commit on another branch is another build.
	if _, err := q.Submit(build(4, "org/a", "refs/heads/z", "1")); err != nil {
		t.Errorf("same commit, other branch: %v", err)
	}
}

func TestFullQueueRefuses(t *testing.T) {
	q := mustNew(t, Settings{MaxRunning: 1, MaxPerRepo: 1, MaxWaiting: 2})
	for i := 0; i < 3; i++ {
		if _, err := q.Submit(build(i, "org/a", fmt.Sprintf("refs/heads/f%d", i), "1")); err != nil {
			t.Fatalf("build %d: %v", i, err)
		}
	}
	if _, err := q.Submit(build(3, "org/a", "refs/heads/f3", "1")); !errors.Is(err, ErrFull) {
		t.Fatalf("a fourth build: %v", err)
	}
	// A newer push of a waiting branch still fits: it replaces.
	if d, err := q.Submit(build(4, "org/a", "refs/heads/f1", "2")); err != nil || ids(d.Replaced) != "b001" {
		t.Fatalf("replacing in a full queue: %+v %v", d, err)
	}
}

func TestRemoveAndPosition(t *testing.T) {
	q := mustNew(t, Settings{MaxRunning: 1, MaxPerRepo: 1})
	for i := 0; i < 4; i++ {
		q.Submit(build(i, "org/a", fmt.Sprintf("refs/heads/f%d", i), "1"))
	}
	if !q.Remove("b002") || q.Remove("b002") || q.Remove("b000") {
		t.Fatal("Remove: waiting b002 once; the running b000 is not waiting")
	}
	if q.Position("b001") != 1 || q.Position("b003") != 2 || q.Position("b000") != 0 || q.Position("b002") != 0 {
		t.Fatalf("positions %d %d %d %d", q.Position("b001"), q.Position("b003"), q.Position("b000"), q.Position("b002"))
	}
}

func TestSettings(t *testing.T) {
	for _, s := range []Settings{{MaxRunning: -1}, {MaxPerRepo: -1}, {MaxWaiting: -1}, {MaxRunning: 3, MaxPerRepo: 4}} {
		if _, err := New(s); err == nil {
			t.Errorf("%+v accepted", s)
		}
	}
	q := mustNew(t, Settings{MaxRunning: 3})
	if q.s.MaxPerRepo != 3 || q.s.MaxWaiting != DefaultMaxWaiting {
		t.Errorf("defaults under a small maxRunning: %+v", q.s)
	}
}

// TestRulesHoldUnderRandomTraffic drives 20,000 random submits, finishes
// and removals and checks after each: the caps hold, a branch runs at most
// one build and waits at most one, nothing waits that could run, and builds
// start in queue order.
func TestRulesHoldUnderRandomTraffic(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	s := Settings{MaxRunning: 6, MaxPerRepo: 3, MaxWaiting: 40}
	q := mustNew(t, s)
	next := 0
	for step := 0; step < 20_000; step++ {
		running, waiting := q.Snapshot()
		var d Decision
		switch op := rng.Intn(10); {
		case op < 6:
			b := build(next, fmt.Sprintf("org/r%d", rng.Intn(5)), fmt.Sprintf("refs/heads/b%d", rng.Intn(6)), fmt.Sprint(rng.Intn(4)))
			b.DefaultBranch = b.Ref == "refs/heads/b0"
			next++
			d, _ = q.Submit(b)
		case op < 9 && len(running) > 0:
			d = q.Finish(running[rng.Intn(len(running))].ID)
		case len(waiting) > 0:
			q.Remove(waiting[rng.Intn(len(waiting))].ID)
		}
		checkRules(t, q, s, d, step)
	}
}

func checkRules(t *testing.T, q *Queue, s Settings, d Decision, step int) {
	t.Helper()
	running, waiting := q.Snapshot()
	if len(running) > s.MaxRunning || len(waiting) > s.MaxWaiting {
		t.Fatalf("step %d: %d running, %d waiting", step, len(running), len(waiting))
	}
	perRepo, runGroup, waitGroup := map[string]int{}, map[string]bool{}, map[string]bool{}
	for _, r := range running {
		perRepo[r.Repo]++
		if runGroup[r.group()] {
			t.Fatalf("step %d: two running builds of %s %s", step, r.Repo, r.Ref)
		}
		runGroup[r.group()] = true
	}
	for repo, n := range perRepo {
		if n > s.MaxPerRepo {
			t.Fatalf("step %d: %s runs %d", step, repo, n)
		}
	}
	for _, w := range waiting {
		if waitGroup[w.group()] {
			t.Fatalf("step %d: two waiting builds of %s %s", step, w.Repo, w.Ref)
		}
		waitGroup[w.group()] = true
		if len(running) < s.MaxRunning && perRepo[w.Repo] < s.MaxPerRepo && !runGroup[w.group()] {
			t.Fatalf("step %d: %s waits though it could run", step, w.ID)
		}
	}
	for i := 1; i < len(d.Start); i++ {
		if less(d.Start[i], d.Start[i-1]) {
			t.Fatalf("step %d: started out of order: %s", step, ids(d.Start))
		}
	}
}

func TestConcurrentUse(t *testing.T) {
	q := mustNew(t, Settings{})
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				b := build(g*1000+i, fmt.Sprintf("org/r%d", g), fmt.Sprintf("refs/heads/b%d", i%7), fmt.Sprint(i))
				if d, err := q.Submit(b); err == nil {
					for _, s := range d.Start {
						q.Finish(s.ID)
					}
				}
				q.Position(b.ID)
			}
		}(g)
	}
	wg.Wait()
	running, waiting := q.Snapshot()
	if len(running) > DefaultMaxRunning || len(waiting) > DefaultMaxWaiting {
		t.Fatalf("%d running, %d waiting", len(running), len(waiting))
	}
}

// maxHeapPerBuild caps the queue's own memory for one waiting build (the
// build's strings belong to the caller), measured with 10,000 of them:
// about 96 bytes, a fifth more allowed. The CI design's pass line is 128
// MiB for the whole controller.
const maxHeapPerBuild = 120

func TestMemoryPerWaitingBuild(t *testing.T) {
	q := mustNew(t, Settings{MaxWaiting: 20_000})
	builds := make([]Build, 10_000)
	for i := range builds {
		builds[i] = build(i, fmt.Sprintf("org/r%d", i%50), fmt.Sprintf("refs/heads/b%05d", i), "1")
	}
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for _, b := range builds {
		if _, err := q.Submit(b); err != nil {
			t.Fatal(err)
		}
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	per := int(after.HeapAlloc-before.HeapAlloc) / 10_000
	t.Logf("about %d bytes of queue memory a waiting build (cap %d)", per, maxHeapPerBuild)
	if per > maxHeapPerBuild {
		t.Fatalf("%d bytes a waiting build, the cap is %d", per, maxHeapPerBuild)
	}
	runtime.KeepAlive(q)
}

// maxSubmitAllocs caps the allocations of one submit into a full default
// queue (1,000 waiting, every repository at its share), so the cost of a
// submit does not grow with the queue. One allocation is the test's own
// new commit string.
const maxSubmitAllocs = 2

func TestSubmitCostDoesNotGrowWithTheQueue(t *testing.T) {
	q := mustNew(t, Settings{})
	for i := 0; i < DefaultMaxWaiting+DefaultMaxRunning; i++ {
		if _, err := q.Submit(build(i, fmt.Sprintf("org/r%d", i%2), fmt.Sprintf("refs/heads/b%05d", i), "1")); err != nil {
			t.Fatal(err)
		}
	}
	extra := build(99_999, "org/r0", "refs/heads/b00002", "2") // replaces a waiting build
	next := build(99_998, "org/r1", "refs/heads/b00003", "2")
	flip := false
	allocs := testing.AllocsPerRun(200, func() {
		b := extra
		if flip {
			b = next
		}
		flip = !flip
		b.SHA = fmt.Sprint(len(b.SHA) + int(time.Now().UnixNano()%1000)) // a new commit each time
		q.Submit(b)
	})
	t.Logf("one submit into a full queue: %.0f allocations (cap %d)", allocs, maxSubmitAllocs)
	if allocs > maxSubmitAllocs {
		t.Fatalf("one submit took %.0f allocations, the cap is %d", allocs, maxSubmitAllocs)
	}
}
