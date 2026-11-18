package k8s

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/clustersync"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/clusternotice"
)

// replicaService is one k8s-service with a cached bundle for each id and a cache on c.
func replicaService(c *cache.Cache, ids ...cluster.ID) *Service {
	s := &Service{cache: c, promQ: newPromQueryCache(time.Minute)}
	for _, id := range ids {
		s.pool().Add(id, &clientBundle{id: id})
	}
	return s
}

func cached(s *Service, id cluster.ID) bool {
	_, ok := s.pool().Peek(id)
	return ok
}

func redisCache(t *testing.T, mr *miniredis.Miniredis) *cache.Cache {
	t.Helper()
	port, err := strconv.Atoi(mr.Port())
	if err != nil {
		t.Fatal(err)
	}
	c := cache.New(mr.Host(), port, 0, "")
	if !c.IsConnected() {
		t.Fatal("not connected to the stand-in")
	}
	return c
}

// changeCounter is a ChangeNotifier that counts.
type changeCounter struct{ ids []cluster.ID }

func (c *changeCounter) Changed(id cluster.ID) { c.ids = append(c.ids, id) }

// registryVersions reads the versions of the mock registry's clusters, as cluster.PostgresRegistry.Versions does.
type registryVersions struct{ reg *mockRegistry }

func (v registryVersions) Versions(context.Context) (map[cluster.ID]int64, error) {
	out := map[cluster.ID]int64{}
	for id, info := range v.reg.clusters {
		out[id] = info.ConfigVersion
	}
	return out, nil
}

func versioned(id cluster.ID, v int64) cluster.Info {
	info := extCluster(id)
	info.ConfigVersion = v
	return info
}

// A bundle carries the version of the registry row it was built from.
func TestABundleCarriesTheVersionItWasBuiltFrom(t *testing.T) {
	reg := &mockRegistry{def: "prod", clusters: map[cluster.ID]cluster.Info{"prod": versioned("prod", 7), "dev": versioned("dev", 2)}}
	s := newTestService(t, reg)
	for _, id := range []cluster.ID{"prod", "dev"} {
		if _, err := s.For(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	got := s.ClusterVersions()
	if len(got) != 2 || got["prod"] != 7 || got["dev"] != 2 {
		t.Fatalf("ClusterVersions = %v, want prod 7, dev 2", got)
	}
}

// A bundle built from a row read just before a change is not taken as current: the next read of the versions drops
// it, whether or not any replica was told. The bundle built from the new row stays, and so does the other cluster's.
func TestABundleBuiltJustBeforeAChangeIsDroppedAtTheNextRead(t *testing.T) {
	reg := &mockRegistry{def: "prod", clusters: map[cluster.ID]cluster.Info{"prod": versioned("prod", 1), "dev": versioned("dev", 5)}}
	s := newTestService(t, reg)
	sync := clustersync.New(registryVersions{reg}, nil)
	ctx := context.Background()
	before, err := s.For(ctx, "prod")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.For(ctx, "dev"); err != nil {
		t.Fatal(err)
	}
	reg.clusters["prod"] = versioned("prod", 2) // auth-service's statement, no call reached this replica

	sync.Compare(ctx, s)
	if cached(s, "prod") {
		t.Fatal("the bundle built from version 1 stayed")
	}
	if !cached(s, "dev") {
		t.Fatal("dev's bundle went")
	}
	after, err := s.For(ctx, "prod")
	if err != nil {
		t.Fatal(err)
	}
	if after == before || after.configVersion != 2 {
		t.Fatalf("rebuilt from version %d", after.configVersion)
	}
	sync.Compare(ctx, s)
	if b, ok := s.pool().Peek("prod"); !ok || b != after {
		t.Fatal("the bundle built from version 2 was dropped")
	}

	delete(reg.clusters, "dev") // deleted, no call reached this replica
	sync.Compare(ctx, s)
	if cached(s, "dev") {
		t.Fatal("the deleted cluster's bundle stayed")
	}
}

// DropStale removes only the bundle built from the version it was read with: one built since stays.
func TestDropStaleKeepsABundleBuiltSince(t *testing.T) {
	s := &Service{promQ: newPromQueryCache(time.Minute)}
	fresh := &clientBundle{id: "prod", configVersion: 2}
	s.pool().Add("prod", fresh)
	s.DropStale("prod", 1)
	if b, ok := s.pool().Peek("prod"); !ok || b != fresh {
		t.Fatal("the bundle built from version 2 was dropped for version 1")
	}
	s.DropStale("prod", 2)
	if cached(s, "prod") {
		t.Fatal("the bundle built from version 2 stayed")
	}
}

// A change read from the versions may have reached no replica, so DropStale flushes the cache in Redis too, unlike a
// change another replica told of.
func TestDropStaleFlushesTheCacheInRedis(t *testing.T) {
	mr := miniredis.RunT(t)
	c := redisCache(t, mr)
	ctx := context.Background()
	s := replicaService(c, "prod")
	notified := &changeCounter{}
	s.SetChangeNotifier(notified)
	c.Set(ctx, "dev|cluster_overview", 1, time.Minute)
	s.DropStale("prod", 0)
	var got int
	if c.Get(ctx, "dev|cluster_overview", &got) {
		t.Fatal("DropStale left the cache in Redis")
	}
	if cached(s, "prod") {
		t.Fatal("DropStale kept the bundle")
	}
	if len(notified.ids) != 0 {
		t.Fatalf("DropStale told the others %v; each reads the versions itself", notified.ids)
	}
}

// auth-service's invalidation reaches one replica. With Redis, the others drop the cluster's bundle on its notice, and
// keep the other clusters'.
func TestAnInvalidationOnOneReplicaDropsTheBundleOnTheOthers(t *testing.T) {
	mr := miniredis.RunT(t)
	reg := &mockRegistry{clusters: map[cluster.ID]cluster.Info{"prod": versioned("prod", 0), "dev": versioned("dev", 0)}}
	var services []*Service
	for range 3 {
		s := replicaService(redisCache(t, mr), "prod", "dev")
		sync := clustersync.New(registryVersions{reg}, redis.NewClient(&redis.Options{Addr: mr.Addr()}))
		sync.Every = time.Hour // the notice alone
		s.SetChangeNotifier(sync)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { sync.Run(ctx, s); close(done) }()
		t.Cleanup(func() { cancel(); <-done })
		services = append(services, s)
	}
	if !eventually(t, 5*time.Second, func() bool { return mr.PubSubNumSub(clusternotice.ChannelFor(0))[clusternotice.ChannelFor(0)] == 3 }) {
		t.Fatal("not subscribed")
	}

	services[0].Invalidate("prod")
	if !eventually(t, 5*time.Second, func() bool { return !cached(services[1], "prod") && !cached(services[2], "prod") }) {
		t.Fatal("the other replicas kept prod's bundle")
	}
	for i, s := range services {
		if cached(s, "prod") {
			t.Errorf("replica %d kept prod", i)
		}
		if !cached(s, "dev") {
			t.Errorf("replica %d dropped dev", i)
		}
	}
}

// Without a notifier Invalidate drops the bundle and the cache on this replica, as before.
func TestInvalidateWithoutANotifierStaysOnThisReplica(t *testing.T) {
	c := cache.New("", 0, 0, "")
	s := replicaService(c, "prod")
	ctx := context.Background()
	c.Set(ctx, "prod|cluster_overview", 1, time.Minute)
	s.Invalidate("prod")
	var got int
	if cached(s, "prod") || c.Get(ctx, "prod|cluster_overview", &got) {
		t.Fatal("bundle or cache entry stayed")
	}
}

// The replica that took the invalidation flushes the cache in Redis and tells the others; a replica dropping a change
// it was told of flushes nothing there and tells no one.
func TestOnlyTheReplicaThatTookTheChangeFlushesRedisAndTellsTheOthers(t *testing.T) {
	mr := miniredis.RunT(t)
	c := redisCache(t, mr)
	ctx := context.Background()

	told := replicaService(c, "prod")
	toldChanges := &changeCounter{}
	told.SetChangeNotifier(toldChanges)
	c.Set(ctx, "dev|cluster_overview", 1, time.Minute)
	told.DropCluster("prod")
	var got int
	if cached(told, "prod") {
		t.Fatal("DropCluster kept the bundle")
	}
	if !c.Get(ctx, "dev|cluster_overview", &got) {
		t.Fatal("DropCluster flushed the cache in Redis, which the replica that took the change flushed already")
	}
	if len(toldChanges.ids) != 0 {
		t.Fatalf("DropCluster told %v", toldChanges.ids)
	}

	took := replicaService(c, "prod")
	tookChanges := &changeCounter{}
	took.SetChangeNotifier(tookChanges)
	took.Invalidate("prod")
	if c.Get(ctx, "dev|cluster_overview", &got) {
		t.Fatal("Invalidate left the cache in Redis")
	}
	if len(tookChanges.ids) != 1 || tookChanges.ids[0] != "prod" {
		t.Fatalf("Invalidate told %v", tookChanges.ids)
	}
}

// A replica whose cache stayed in memory (Redis did not answer at start) flushes it on a change it was told of: no
// other replica can.
func TestDropClusterFlushesACacheInMemory(t *testing.T) {
	c := cache.New("", 0, 0, "")
	s := replicaService(c, "prod")
	ctx := context.Background()
	c.Set(ctx, "prod|cluster_overview", 1, time.Minute)
	s.DropCluster("prod")
	var got int
	if c.Get(ctx, "prod|cluster_overview", &got) {
		t.Fatal("the cache in memory kept the entry")
	}
}
