// Package clustersync drops a cluster's cached state on every k8s-service replica when its registration changes.
//
// auth-service tells one replica (POST /internal/clusters/{id}/invalidate). That replica counts the change in a Redis
// hash, one version per cluster, and publishes a notice; every replica drops the cluster on the notice. Redis pub/sub
// delivers a message at most once, so each replica also reads the hash on a timer and after its subscription comes
// back, and drops each cluster whose version moved past the one it saw. Nothing here reads a cluster: a dropped
// cluster's clients are built again from the registry on their next use, as on the replica auth-service told.
package clustersync

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	mathrand "math/rand/v2"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

const (
	// Channel, with the Redis database number after it (ChannelFor), carries one notice per counted change.
	Channel = "kubeast:clusters:changed"
	// VersionsKey is the hash of versions: the field epoch, and c:<cluster id> for each cluster changed since it was
	// set. Under cache.KeptPrefix, so the cache's flush leaves it.
	VersionsKey  = cache.KeptPrefix + "cluster-versions"
	epochField   = "epoch"
	clusterField = "c:"

	// DefaultEvery is how often a replica reads the versions for a notice it missed.
	DefaultEvery = 30 * time.Second
	// callTimeout bounds one Redis call: a count runs inside auth-service's 5 s call to the replica.
	callTimeout = 2 * time.Second
	warnEvery   = time.Minute
)

type notice struct {
	Epoch   string `json:"epoch"`
	Cluster string `json:"cluster"`
	Version int64  `json:"version"`
}

// ChannelFor is the channel of the install whose keys are in database db. Pub/sub ignores database numbers, so two
// installs sharing one Redis on two databases would otherwise hear each other's notices.
func ChannelFor(db int) string { return Channel + ":" + strconv.Itoa(db) }

// Sync follows the versions for one replica.
type Sync struct {
	rdb     *redis.Client
	channel string
	// Every is how often the versions are read, spread by a fifth either way; 0 = DefaultEvery.
	Every time.Duration

	mu   sync.Mutex
	drop func(cluster.ID)
	// loaded: the versions have been read once; until then nothing here is known to be cached.
	loaded bool
	// epoch is the hash's epoch the versions in seen belong to. A hash Redis lost starts a new one at the next count,
	// and the versions of another epoch say nothing.
	epoch string
	seen  map[cluster.ID]int64
	// pending are changes this replica dropped but Redis did not count; each is counted on a later read.
	pending  map[cluster.ID]struct{}
	warnedAt time.Time
}

// New follows the versions in rdb's Redis.
func New(rdb *redis.Client) *Sync {
	return &Sync{rdb: rdb, channel: ChannelFor(rdb.Options().DB), seen: map[cluster.ID]int64{}, pending: map[cluster.ID]struct{}{}}
}

// Load reads the versions before this process caches any cluster: a change counted before it is in what the process
// then reads from the registry, and is not dropped again. On an error the first read that works takes the versions
// as they are.
func (s *Sync) Load(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	fields, err := s.rdb.HGetAll(ctx, VersionsKey).Result()
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.epoch, s.seen = parse(fields)
	s.loaded = true
	return nil
}

// Changed counts a change of id this replica has dropped and tells the others. A change Redis does not take now is
// counted on a later read.
func (s *Sync) Changed(id cluster.ID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	if err := s.countLocked(ctx, id); err != nil {
		s.pending[id] = struct{}{}
		s.warnLocked("clustersync: change not counted in Redis, counted on a later read", "cluster", id, "err", err)
	}
}

// Run follows the notices until ctx ends, calling drop for each cluster another replica changed.
func (s *Sync) Run(ctx context.Context, drop func(cluster.ID)) {
	s.mu.Lock()
	s.drop = drop
	s.mu.Unlock()

	ps := s.rdb.Subscribe(ctx, s.channel)
	defer ps.Close()
	msgs := ps.ChannelWithSubscriptions()
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
				return
			}
			switch m := m.(type) {
			case *redis.Subscription:
				// subscribed again after a lost connection: the notices sent meanwhile are gone
				if m.Kind == "subscribe" {
					s.compare(ctx)
				}
			case *redis.Message:
				s.notice(m.Payload)
			}
		case <-t.C:
			s.compare(ctx)
			t.Reset(spread(every))
		}
	}
}

// countLocked adds one to id's version and publishes the notice. The publish may fail: the others read the version.
func (s *Sync) countLocked(ctx context.Context, id cluster.ID) error {
	var incr *redis.IntCmd
	var epoch *redis.StringCmd
	_, err := s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSetNX(ctx, VersionsKey, epochField, newEpoch())
		incr = p.HIncrBy(ctx, VersionsKey, clusterField+string(id), 1)
		epoch = p.HGet(ctx, VersionsKey, epochField)
		return nil
	})
	if err != nil {
		return err
	}
	n := notice{Epoch: epoch.Val(), Cluster: string(id), Version: incr.Val()}
	// this replica dropped id already: its own notice must find the version seen
	s.takeEpochLocked(n.Epoch)
	s.seen[id] = max(s.seen[id], n.Version)
	payload, _ := json.Marshal(n)
	if err := s.rdb.Publish(ctx, s.channel, payload).Err(); err != nil {
		s.warnLocked("clustersync: notice not published, the others read the version", "cluster", id, "err", err)
	}
	return nil
}

func (s *Sync) notice(payload string) {
	var n notice
	if err := json.Unmarshal([]byte(payload), &n); err != nil || n.Cluster == "" || n.Epoch == "" {
		slog.Warn("clustersync: notice not understood", "payload_len", len(payload))
		return
	}
	id := cluster.ID(n.Cluster)
	s.mu.Lock()
	if s.loaded {
		s.takeEpochLocked(n.Epoch)
		if n.Version <= s.seen[id] {
			s.mu.Unlock()
			return
		}
		s.seen[id] = n.Version
	}
	// not loaded yet: the change is newer than anything cached here, and the first read takes the versions
	drop := s.drop
	s.mu.Unlock()
	slog.Info("clustersync: cluster changed on another replica, dropping what this one keeps of it", "cluster", id)
	if drop != nil {
		drop(id)
	}
}

// compare counts what is pending, reads the versions and drops each cluster whose version moved past the one seen.
func (s *Sync) compare(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	s.mu.Lock()
	for id := range s.pending {
		if err := s.countLocked(ctx, id); err != nil {
			s.warnLocked("clustersync: Redis does not answer", "err", err)
			s.mu.Unlock()
			return
		}
		delete(s.pending, id)
	}
	fields, err := s.rdb.HGetAll(ctx, VersionsKey).Result()
	if err != nil {
		s.warnLocked("clustersync: Redis does not answer", "err", err)
		s.mu.Unlock()
		return
	}
	epoch, versions := parse(fields)
	var drops []cluster.ID
	switch {
	case !s.loaded:
		s.epoch, s.seen, s.loaded = epoch, versions, true
	case epoch == "":
		// Redis lost the hash and nothing was counted since; the next count starts a new epoch
	default:
		s.takeEpochLocked(epoch)
		for id, v := range versions {
			if v > s.seen[id] {
				s.seen[id] = v
				drops = append(drops, id)
			}
		}
	}
	drop := s.drop
	s.mu.Unlock()
	for _, id := range drops {
		slog.Info("clustersync: cluster changed on another replica (read from the versions), dropping what this one keeps of it", "cluster", id)
		if drop != nil {
			drop(id)
		}
	}
}

// takeEpochLocked moves to epoch, forgetting the versions of the one before.
func (s *Sync) takeEpochLocked(epoch string) {
	if epoch != "" && epoch != s.epoch {
		s.epoch, s.seen = epoch, map[cluster.ID]int64{}
	}
}

// warnLocked logs at most once a minute while Redis does not answer.
func (s *Sync) warnLocked(msg string, args ...any) {
	if now := time.Now(); now.Sub(s.warnedAt) >= warnEvery {
		s.warnedAt = now
		slog.Warn(msg, args...)
	}
}

func parse(fields map[string]string) (string, map[cluster.ID]int64) {
	versions := map[cluster.ID]int64{}
	for k, v := range fields {
		id, ok := strings.CutPrefix(k, clusterField)
		if !ok {
			continue
		}
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			versions[cluster.ID(id)] = n
		}
	}
	return fields[epochField], versions
}

func newEpoch() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// spread is d give or take a fifth, so replicas started together do not read at one moment.
func spread(d time.Duration) time.Duration {
	return d - d/5 + mathrand.N(2*d/5+1)
}
