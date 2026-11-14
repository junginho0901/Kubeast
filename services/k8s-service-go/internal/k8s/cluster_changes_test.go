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

// auth-service's invalidation reaches one replica. With a notifier, the others drop the cluster's bundle too, and
// keep the other clusters'.
func TestAnInvalidationOnOneReplicaDropsTheBundleOnTheOthers(t *testing.T) {
	mr := miniredis.RunT(t)
	var services []*Service
	for range 3 {
		s := replicaService(redisCache(t, mr), "prod", "dev")
		sync := clustersync.New(redis.NewClient(&redis.Options{Addr: mr.Addr()}))
		if err := sync.Load(context.Background()); err != nil {
			t.Fatal(err)
		}
		s.SetChangeNotifier(sync)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { sync.Run(ctx, s.DropCluster); close(done) }()
		t.Cleanup(func() { cancel(); <-done })
		services = append(services, s)
	}
	if !eventually(t, 5*time.Second, func() bool { return mr.PubSubNumSub(clustersync.ChannelFor(0))[clustersync.ChannelFor(0)] == 3 }) {
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

// Without Redis there is no notifier: Invalidate drops the bundle and the cache on this replica, as before.
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

// The replica that took the invalidation flushes the cache in Redis and counts the change; a replica dropping a
// change it was told of flushes nothing there and counts nothing.
func TestOnlyTheReplicaThatTookTheChangeFlushesRedisAndCountsIt(t *testing.T) {
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
		t.Fatalf("DropCluster counted %v", toldChanges.ids)
	}

	took := replicaService(c, "prod")
	tookChanges := &changeCounter{}
	took.SetChangeNotifier(tookChanges)
	took.Invalidate("prod")
	if c.Get(ctx, "dev|cluster_overview", &got) {
		t.Fatal("Invalidate left the cache in Redis")
	}
	if len(tookChanges.ids) != 1 || tookChanges.ids[0] != "prod" {
		t.Fatalf("Invalidate counted %v", tookChanges.ids)
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
