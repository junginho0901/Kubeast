package clustersync

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// replica is one k8s-service's Sync and the clusters it dropped, in order.
type replica struct {
	*Sync
	mu      sync.Mutex
	dropped []cluster.ID
}

func (r *replica) drop(id cluster.ID) {
	r.mu.Lock()
	r.dropped = append(r.dropped, id)
	r.mu.Unlock()
}

func (r *replica) drops() []cluster.ID {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]cluster.ID(nil), r.dropped...)
}

func newReplica(t *testing.T, mr *miniredis.Miniredis, every time.Duration) *replica {
	t.Helper()
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr(), MaxRetries: -1})
	t.Cleanup(func() { _ = rdb.Close() })
	r := &replica{Sync: New(rdb)}
	r.Every = every
	return r
}

// start loads and runs r until the test ends.
func (r *replica) start(t *testing.T) {
	t.Helper()
	if err := r.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.run(t)
}

func (r *replica) run(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.Run(ctx, r.drop); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
}

func waitSubscribers(t *testing.T, mr *miniredis.Miniredis, n int) {
	t.Helper()
	eventually(t, func() bool { return mr.PubSubNumSub(ChannelFor(0))[ChannelFor(0)] == n })
}

func eventually(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("not within 5 s")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func equal(a, b []cluster.ID) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The replica auth-service told counts the change; each other replica drops the cluster once, on the notice, and
// its later reads of the versions drop nothing more. The replica that counted it drops nothing here: it already did.
func TestAChangeIsDroppedOnceOnEveryOtherReplica(t *testing.T) {
	mr := miniredis.RunT(t)
	a, b, c := newReplica(t, mr, 30*time.Millisecond), newReplica(t, mr, 30*time.Millisecond), newReplica(t, mr, 30*time.Millisecond)
	a.start(t)
	b.start(t)
	c.start(t)
	waitSubscribers(t, mr, 3)

	a.Changed("prod")
	want := []cluster.ID{"prod"}
	eventually(t, func() bool { return equal(b.drops(), want) && equal(c.drops(), want) })
	time.Sleep(200 * time.Millisecond) // several reads of the versions
	if got := b.drops(); !equal(got, want) {
		t.Errorf("b dropped %v, want %v", got, want)
	}
	if got := c.drops(); !equal(got, want) {
		t.Errorf("c dropped %v, want %v", got, want)
	}
	if got := a.drops(); len(got) != 0 {
		t.Errorf("a dropped %v on its own change", got)
	}
	if got := mr.HGet(VersionsKey, "c:prod"); got != "1" {
		t.Errorf("version %q, want 1", got)
	}
}

// A replica that was not subscribed when the change was counted finds it in the versions as soon as it subscribes.
func TestANoticeMissedIsReadFromTheVersions(t *testing.T) {
	mr := miniredis.RunT(t)
	a := newReplica(t, mr, time.Hour)
	b := newReplica(t, mr, time.Hour) // no timed read: only the read on subscribing finds it
	a.start(t)
	if err := b.Load(context.Background()); err != nil {
		t.Fatal(err)
	}

	a.Changed("prod")
	a.Changed("dev")
	b.run(t)
	eventually(t, func() bool { return len(b.drops()) == 2 })
	time.Sleep(100 * time.Millisecond)
	if got := b.drops(); len(got) != 2 || got[0] == got[1] {
		t.Fatalf("b dropped %v, want prod and dev once each", got)
	}
}

// What was counted before a replica read the versions is in what it reads from the registry: it drops nothing.
func TestChangesBeforeLoadAreNotDropped(t *testing.T) {
	mr := miniredis.RunT(t)
	a := newReplica(t, mr, time.Hour)
	a.start(t)
	a.Changed("prod")
	a.Changed("prod")

	b := newReplica(t, mr, 20*time.Millisecond)
	b.start(t)
	waitSubscribers(t, mr, 2)
	time.Sleep(150 * time.Millisecond)
	if got := b.drops(); len(got) != 0 {
		t.Fatalf("b dropped %v at start", got)
	}
}

// Redis that lost its data starts the versions again under a new epoch: a change after that is dropped even where its
// version is lower than the one seen before, and a cluster not changed since is not.
func TestVersionsLostInRedisStartANewEpoch(t *testing.T) {
	mr := miniredis.RunT(t)
	a, b := newReplica(t, mr, 20*time.Millisecond), newReplica(t, mr, 20*time.Millisecond)
	a.start(t)
	b.start(t)
	waitSubscribers(t, mr, 2)
	for range 3 {
		a.Changed("prod")
	}
	a.Changed("dev")
	eventually(t, func() bool { return len(b.drops()) == 4 })
	before := mr.HGet(VersionsKey, epochField)

	mr.FlushAll()
	time.Sleep(100 * time.Millisecond) // reads of an empty hash change nothing
	a.Changed("prod")
	eventually(t, func() bool { return len(b.drops()) == 5 })
	time.Sleep(100 * time.Millisecond)
	got := b.drops()
	if len(got) != 5 || got[4] != "prod" {
		t.Fatalf("b dropped %v, want prod once more and not dev", got)
	}
	if after := mr.HGet(VersionsKey, epochField); after == "" || after == before {
		t.Fatalf("epoch %q after %q", after, before)
	}
	if v := mr.HGet(VersionsKey, "c:prod"); v != "1" {
		t.Fatalf("prod version %q, want 1 in the new epoch", v)
	}
}

// A change Redis does not take is dropped on the replica that took it and counted on its next read once Redis
// answers, so the others still drop it.
func TestAChangeRedisDidNotTakeIsCountedLater(t *testing.T) {
	mr := miniredis.RunT(t)
	a, b := newReplica(t, mr, 20*time.Millisecond), newReplica(t, mr, 20*time.Millisecond)
	a.start(t)
	b.start(t)
	waitSubscribers(t, mr, 2)

	mr.SetError("LOADING Redis is loading the dataset in memory")
	a.Changed("prod")
	time.Sleep(100 * time.Millisecond)
	if got := b.drops(); len(got) != 0 {
		t.Fatalf("b dropped %v while Redis refused", got)
	}
	mr.SetError("")
	eventually(t, func() bool { return equal(b.drops(), []cluster.ID{"prod"}) })
	time.Sleep(100 * time.Millisecond)
	if got := b.drops(); !equal(got, []cluster.ID{"prod"}) {
		t.Fatalf("b dropped %v, want prod once", got)
	}
	if got := a.drops(); len(got) != 0 {
		t.Fatalf("a dropped %v", got)
	}
}

// A replica that could not read the versions at start takes them on its first read without dropping, and drops what
// changes after.
func TestAReplicaThatCouldNotLoadTakesTheVersionsOnItsFirstRead(t *testing.T) {
	mr := miniredis.RunT(t)
	a := newReplica(t, mr, time.Hour)
	a.start(t)
	a.Changed("prod")

	b := newReplica(t, mr, 20*time.Millisecond)
	b.run(t) // no Load
	waitSubscribers(t, mr, 2)
	time.Sleep(100 * time.Millisecond)
	if got := b.drops(); len(got) != 0 {
		t.Fatalf("b dropped %v on its first read", got)
	}
	a.Changed("prod")
	eventually(t, func() bool { return equal(b.drops(), []cluster.ID{"prod"}) })
}

// Two installs sharing one Redis on two databases keep their notices and versions apart: pub/sub ignores the
// database number, the channel names it.
func TestInstallsOnTwoDatabasesDoNotHearEachOther(t *testing.T) {
	mr := miniredis.RunT(t)
	onDB := func(db int) *replica {
		rdb := redis.NewClient(&redis.Options{Addr: mr.Addr(), DB: db, MaxRetries: -1})
		t.Cleanup(func() { _ = rdb.Close() })
		r := &replica{Sync: New(rdb)}
		r.Every = 20 * time.Millisecond
		r.start(t)
		return r
	}
	a, b := onDB(0), onDB(1)
	eventually(t, func() bool { // both subscribed, whatever the channels' names
		total := 0
		for _, n := range mr.PubSubNumSub(mr.PubSubChannels(Channel + "*")...) {
			total += n
		}
		return total == 2
	})
	a.Changed("prod")
	time.Sleep(150 * time.Millisecond)
	if got := b.drops(); len(got) != 0 {
		t.Fatalf("the install on db 1 dropped %v", got)
	}
}

// A notice that is not one of ours changes nothing.
func TestANoticeNotUnderstoodIsIgnored(t *testing.T) {
	mr := miniredis.RunT(t)
	b := newReplica(t, mr, time.Hour)
	b.start(t)
	waitSubscribers(t, mr, 1)
	mr.Publish(ChannelFor(0), "not json")
	mr.Publish(ChannelFor(0), `{"epoch":"","cluster":"prod","version":1}`)
	time.Sleep(100 * time.Millisecond)
	if got := b.drops(); len(got) != 0 {
		t.Fatalf("dropped %v", got)
	}
}

func TestSpreadStaysWithinAFifth(t *testing.T) {
	for range 1000 {
		if d := spread(30 * time.Second); d < 24*time.Second || d > 36*time.Second {
			t.Fatalf("spread %v", d)
		}
	}
}
