// Package clustersync drops a cluster's cached state on every k8s-service replica when its registration changes.
//
// auth-service changes what a cluster's connection is built from (kubeconfig, Prometheus or log store) in the
// statement that sets the row's config_version (services/pkg/cluster PostgresRegistry), and a deleted cluster has no
// row. Each bundle carries the version it was built from; every replica reads all clusters' versions every few seconds
// and drops each bundle built from another version or of a cluster gone. That alone reaches every replica within one
// read, with or without Redis, and a bundle built from a row read just before a change is dropped at the next read.
//
// auth-service also tells one replica (POST /internal/clusters/{id}/invalidate). With Redis that replica publishes a
// notice and the others drop the cluster at once. Pub/sub delivers a message at most once; a notice lost costs only the
// time until the next read. Nothing here reads a cluster: a dropped cluster's clients are built again from the registry
// on their next use. The channel and the message are services/pkg/clusternotice's, which tool-server listens with.
package clustersync

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	mathrand "math/rand/v2"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/clusternotice"
)

const (
	// DefaultEvery is how often a replica reads the versions: a change reaches every replica within this and a fifth.
	DefaultEvery = 5 * time.Second
	// callTimeout bounds one read of the versions or one publish.
	callTimeout = 2 * time.Second
	warnEvery   = time.Minute
)

// Versions reads every registered cluster's config_version (cluster.PostgresRegistry.Versions); a cluster with no
// entry is gone.
type Versions interface {
	Versions(ctx context.Context) (map[cluster.ID]int64, error)
}

// Replica is what one k8s-service process keeps of the clusters (k8s.Service).
type Replica interface {
	// ClusterVersions is the version each kept cluster's bundle was built from.
	ClusterVersions() map[cluster.ID]int64
	// DropStale drops the bundle of id built from builtFrom, read as changed in the registry.
	DropStale(id cluster.ID, builtFrom int64)
	// DropCluster drops id on another replica's notice.
	DropCluster(id cluster.ID)
	// Registered says how many clusters the registry holds, at each read of the versions.
	Registered(clusters int)
}

// Sync follows the cluster versions for one replica.
type Sync struct {
	versions Versions
	// rdb carries the notices; nil = none, the versions alone.
	rdb     *redis.Client
	channel string
	self    string
	// Every is how often the versions are read, spread by a fifth either way; 0 = DefaultEvery.
	Every time.Duration

	mu       sync.Mutex
	warnedAt time.Time
}

// New follows versions, with notices through rdb when it is not nil.
func New(versions Versions, rdb *redis.Client) *Sync {
	s := &Sync{versions: versions, rdb: rdb, self: processID()}
	if rdb != nil {
		s.channel = clusternotice.ChannelFor(rdb.Options().DB)
	}
	return s
}

// Changed tells the other replicas that this one dropped id. Without Redis, or when the publish fails, they read the
// change from the versions.
func (s *Sync) Changed(id cluster.ID) {
	if s.rdb == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	payload, _ := json.Marshal(clusternotice.Notice{Cluster: string(id), From: s.self})
	if err := s.rdb.Publish(ctx, s.channel, payload).Err(); err != nil {
		s.warn("clustersync: notice not published, the other replicas read the change from the versions", "cluster", id, "err", err)
	}
}

// Run reads the versions and follows the notices until ctx ends.
func (s *Sync) Run(ctx context.Context, r Replica) {
	var msgs <-chan interface{}
	if s.rdb != nil {
		ps := s.rdb.Subscribe(ctx, s.channel)
		defer ps.Close()
		msgs = ps.ChannelWithSubscriptions()
	}
	every := s.Every
	if every <= 0 {
		every = DefaultEvery
	}
	t := time.NewTimer(spread(every))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-msgs:
			if !ok {
				msgs = nil // the versions go on
				continue
			}
			switch m := m.(type) {
			case *redis.Subscription:
				// subscribed again after a lost connection: the notices sent meanwhile are gone
				if m.Kind == "subscribe" {
					s.Compare(ctx, r)
				}
			case *redis.Message:
				s.notice(m.Payload, r)
			}
		case <-t.C:
			s.Compare(ctx, r)
			t.Reset(spread(every))
		}
	}
}

// Compare reads the versions once, says how many clusters there are and drops each bundle built from another version or
// of a cluster gone. A read that fails does neither; the next one compares again.
func (s *Sync) Compare(ctx context.Context, r Replica) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	versions, err := s.versions.Versions(ctx)
	if err != nil {
		s.warn("clustersync: cluster versions not read, compared on a later read", "err", err)
		return
	}
	r.Registered(len(versions))
	for id, built := range r.ClusterVersions() {
		v, ok := versions[id]
		if ok && v == built {
			continue
		}
		slog.Info("clustersync: cluster changed in the registry, dropping what this replica keeps of it", "cluster", id, "deleted", !ok)
		r.DropStale(id, built)
	}
}

func (s *Sync) notice(payload string, r Replica) {
	n, err := clusternotice.Decode(payload)
	if err != nil {
		slog.Warn("clustersync: notice not understood", "payload_len", len(payload))
		return
	}
	if n.From == s.self {
		return
	}
	id := cluster.ID(n.Cluster)
	slog.Info("clustersync: cluster changed on another replica, dropping what this one keeps of it", "cluster", id)
	r.DropCluster(id)
}

// warn logs at most once a minute while the database or Redis does not answer.
func (s *Sync) warn(msg string, args ...any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if now := time.Now(); now.Sub(s.warnedAt) >= warnEvery {
		s.warnedAt = now
		slog.Warn(msg, args...)
	}
}

func processID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// spread is d give or take a fifth, so replicas started together do not read at one moment.
func spread(d time.Duration) time.Duration {
	return d - d/5 + mathrand.N(2*d/5+1)
}
