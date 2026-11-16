package clustersync

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/clusternotice"
)

// registry is the clusters table's versions; err makes a read fail.
type registry struct {
	mu       sync.Mutex
	versions map[cluster.ID]int64
	err      error
	reads    int
}

func (g *registry) Versions(context.Context) (map[cluster.ID]int64, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.reads++
	if g.err != nil {
		return nil, g.err
	}
	out := make(map[cluster.ID]int64, len(g.versions))
	for id, v := range g.versions {
		out[id] = v
	}
	return out, nil
}

func (g *registry) set(id cluster.ID, v int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.versions == nil {
		g.versions = map[cluster.ID]int64{}
	}
	g.versions[id] = v
}

func (g *registry) remove(id cluster.ID) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.versions, id)
}

// replica is one k8s-service: the version each kept bundle was built from, and what it dropped. A dropped bundle is
// built again only on use, so it stays out of kept.
type replica struct {
	*Sync
	mu      sync.Mutex
	kept    map[cluster.ID]int64
	stale   []string
	notices []cluster.ID
}

func (r *replica) ClusterVersions() map[cluster.ID]int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[cluster.ID]int64, len(r.kept))
	for id, v := range r.kept {
		out[id] = v
	}
	return out
}

func (r *replica) DropStale(id cluster.ID, builtFrom int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.kept[id] == builtFrom {
		delete(r.kept, id)
	}
	r.stale = append(r.stale, string(id))
}

func (r *replica) DropCluster(id cluster.ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.kept, id)
	r.notices = append(r.notices, id)
}

func (r *replica) build(id cluster.ID, v int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.kept[id] = v
}

func (r *replica) staleDrops() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := append([]string(nil), r.stale...)
	sort.Strings(out)
	return out
}

func (r *replica) noticeDrops() []cluster.ID {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]cluster.ID(nil), r.notices...)
}

func newReplica(t *testing.T, g *registry, mr *miniredis.Miniredis, every time.Duration) *replica {
	t.Helper()
	var rdb *redis.Client
	if mr != nil {
		rdb = redis.NewClient(&redis.Options{Addr: mr.Addr(), MaxRetries: -1})
		t.Cleanup(func() { _ = rdb.Close() })
	}
	r := &replica{Sync: New(g, rdb), kept: map[cluster.ID]int64{}}
	r.Every = every
	return r
}

// run runs r until the test ends.
func (r *replica) run(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.Run(ctx, r); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
}

func waitSubscribers(t *testing.T, mr *miniredis.Miniredis, n int) {
	t.Helper()
	eventually(t, func() bool { return mr.PubSubNumSub(clusternotice.ChannelFor(0))[clusternotice.ChannelFor(0)] == n })
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

func equal[T comparable](a, b []T) bool {
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

// A read of the versions drops each bundle built from another version and each of a cluster gone, and keeps the
// bundles built from the version the registry has.
func TestABundleBuiltFromAnotherVersionOrOfAClusterGoneIsDropped(t *testing.T) {
	g := &registry{versions: map[cluster.ID]int64{"prod": 8, "dev": 3}}
	r := newReplica(t, g, nil, time.Hour)
	r.build("prod", 7) // built before the change
	r.build("dev", 3)  // current
	r.build("old", 4)  // deleted since
	r.build("re", 0)   // deleted and registered again: a new row, a new value
	g.set("re", 12)
	r.Compare(context.Background(), r)
	if got, want := r.staleDrops(), []string{"old", "prod", "re"}; !equal(got, want) {
		t.Fatalf("dropped %v, want %v", got, want)
	}
	if got := r.ClusterVersions(); len(got) != 1 || got["dev"] != 3 {
		t.Fatalf("kept %v, want dev at 3", got)
	}
	r.build("prod", 8) // built again from the new row
	r.Compare(context.Background(), r)
	if got := r.staleDrops(); len(got) != 3 {
		t.Fatalf("the rebuilt bundle was dropped too: %v", got)
	}
}

// A read that fails drops nothing; the next one that works compares as usual.
func TestAVersionsReadThatFailsDropsNothing(t *testing.T) {
	g := &registry{versions: map[cluster.ID]int64{"prod": 2}, err: errors.New("database down")}
	r := newReplica(t, g, nil, time.Hour)
	r.build("prod", 1)
	r.Compare(context.Background(), r)
	if got := r.staleDrops(); len(got) != 0 {
		t.Fatalf("dropped %v on a failed read", got)
	}
	g.mu.Lock()
	g.err = nil
	g.mu.Unlock()
	r.Compare(context.Background(), r)
	if got := r.staleDrops(); !equal(got, []string{"prod"}) {
		t.Fatalf("dropped %v after the read came back", got)
	}
}

// Without Redis the versions alone reach the replica, on its timer.
func TestWithoutRedisTheVersionsStillReachTheReplica(t *testing.T) {
	g := &registry{versions: map[cluster.ID]int64{"prod": 1}}
	r := newReplica(t, g, nil, 20*time.Millisecond)
	r.build("prod", 1)
	r.Changed("prod") // no Redis: nothing to publish, nothing panics
	r.run(t)
	time.Sleep(60 * time.Millisecond)
	if got := r.staleDrops(); len(got) != 0 {
		t.Fatalf("dropped %v with nothing changed", got)
	}
	g.set("prod", 2)
	eventually(t, func() bool { return equal(r.staleDrops(), []string{"prod"}) })
}

// The replica auth-service told publishes a notice; each other replica drops the cluster on it, at once, and the
// publisher, which dropped it already, does not hear its own.
func TestANoticeDropsTheClusterOnTheOtherReplicasNotOnItsOwn(t *testing.T) {
	mr := miniredis.RunT(t)
	g := &registry{versions: map[cluster.ID]int64{"prod": 1, "dev": 1}}
	var rs []*replica
	for range 3 {
		r := newReplica(t, g, mr, time.Hour) // no timed read: only the notice can drop it
		r.build("prod", 1)
		r.build("dev", 1)
		r.run(t)
		rs = append(rs, r)
	}
	waitSubscribers(t, mr, 3)
	// the reads made on subscribing found nothing changed
	for i, r := range rs {
		if got := r.staleDrops(); len(got) != 0 {
			t.Fatalf("replica %d dropped %v on subscribing", i, got)
		}
	}

	rs[0].Changed("prod")
	want := []cluster.ID{"prod"}
	eventually(t, func() bool { return equal(rs[1].noticeDrops(), want) && equal(rs[2].noticeDrops(), want) })
	time.Sleep(50 * time.Millisecond)
	if got := rs[0].noticeDrops(); len(got) != 0 {
		t.Errorf("the publisher dropped %v on its own notice", got)
	}
	for i, r := range rs {
		if _, ok := r.ClusterVersions()["dev"]; !ok {
			t.Errorf("replica %d dropped dev", i)
		}
	}
}

// A replica that subscribes, again or for the first time, reads the versions at once: a notice sent while it was
// not subscribed is gone, the version is not.
func TestASubscriptionReadsTheVersionsAtOnce(t *testing.T) {
	mr := miniredis.RunT(t)
	g := &registry{versions: map[cluster.ID]int64{"prod": 2}}
	r := newReplica(t, g, mr, time.Hour)
	r.build("prod", 1)
	r.run(t)
	eventually(t, func() bool { return equal(r.staleDrops(), []string{"prod"}) })
}

// Two installs sharing one Redis on two databases keep their notices apart: pub/sub ignores the database number, the
// channel names it.
func TestInstallsOnTwoDatabasesDoNotHearEachOther(t *testing.T) {
	mr := miniredis.RunT(t)
	g := &registry{versions: map[cluster.ID]int64{"prod": 1}}
	onDB := func(db int) *replica {
		rdb := redis.NewClient(&redis.Options{Addr: mr.Addr(), DB: db, MaxRetries: -1})
		t.Cleanup(func() { _ = rdb.Close() })
		r := &replica{Sync: New(g, rdb), kept: map[cluster.ID]int64{"prod": 1}}
		r.Every = time.Hour
		r.run(t)
		return r
	}
	a, b := onDB(0), onDB(1)
	eventually(t, func() bool { // both subscribed, whatever the channels' names
		total := 0
		for _, n := range mr.PubSubNumSub(mr.PubSubChannels(clusternotice.Channel + "*")...) {
			total += n
		}
		return total == 2
	})
	a.Changed("prod")
	time.Sleep(150 * time.Millisecond)
	if got := b.noticeDrops(); len(got) != 0 {
		t.Fatalf("the install on db 1 dropped %v", got)
	}
}

// A notice that is not one of ours changes nothing.
func TestANoticeNotUnderstoodIsIgnored(t *testing.T) {
	mr := miniredis.RunT(t)
	g := &registry{}
	b := newReplica(t, g, mr, time.Hour)
	b.run(t)
	waitSubscribers(t, mr, 1)
	mr.Publish(clusternotice.ChannelFor(0), "not json")
	mr.Publish(clusternotice.ChannelFor(0), `{"from":"someone"}`)
	time.Sleep(100 * time.Millisecond)
	if got := b.noticeDrops(); len(got) != 0 {
		t.Fatalf("dropped %v", got)
	}
}

func TestSpreadStaysWithinAFifth(t *testing.T) {
	for range 1000 {
		if d := spread(DefaultEvery); d < 4*time.Second || d > 6*time.Second {
			t.Fatalf("spread %v", d)
		}
	}
}

// A replica whose Redis did not answer when it started listens for the notices once Redis answers (the client
// subscribes again by itself) and reads the versions on subscribing, so what changed meanwhile is dropped then.
func TestAReplicaStartedWithoutRedisHearsTheNoticesOnceRedisAnswers(t *testing.T) {
	mr := miniredis.NewMiniRedis()
	if err := mr.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mr.Close)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr(), MaxRetries: -1}) // the address, before the stand-in stops
	t.Cleanup(func() { _ = rdb.Close() })
	mr.Close()
	g := &registry{versions: map[cluster.ID]int64{"prod": 2, "dev": 1}}
	b := &replica{Sync: New(g, rdb), kept: map[cluster.ID]int64{}}
	b.Every = time.Hour // no timed read
	b.build("prod", 1)  // changed while Redis was down
	b.build("dev", 1)
	b.run(t)
	time.Sleep(100 * time.Millisecond)
	if got := b.staleDrops(); len(got) != 0 {
		t.Fatalf("dropped %v before Redis answered", got)
	}

	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
	waitSubscribers(t, mr, 1)
	eventually(t, func() bool { return equal(b.staleDrops(), []string{"prod"}) })
	a := newReplica(t, g, mr, time.Hour)
	a.Changed("dev")
	eventually(t, func() bool { return equal(b.noticeDrops(), []cluster.ID{"dev"}) })
}

// The chart's Redis user k8s-service publishes and subscribes on channels under kubeast: only (&kubeast:*).
func TestTheChannelIsWithinTheACLChannelPattern(t *testing.T) {
	for _, db := range []int{0, 3, 15} {
		if ch := clusternotice.ChannelFor(db); !strings.HasPrefix(ch, "kubeast:") {
			t.Fatalf("channel %q for db %d is outside kubeast:", ch, db)
		}
	}
}
