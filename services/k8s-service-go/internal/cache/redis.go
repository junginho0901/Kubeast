package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// Cache provides Redis caching with in-memory fallback.
type Cache struct {
	rdb       *redis.Client
	connected bool
	// noTTL logs once that an entry came without a positive TTL (Set).
	noTTL sync.Once

	mu      sync.RWMutex
	mem     map[string]memEntry
	memOnce sync.Once
	// memSweepAt is the entry count at which Set next looks for expired entries.
	memSweepAt int
}

type memEntry struct {
	data    []byte
	expires time.Time
}

// Prefix starts every key the cache reads, writes and deletes in Redis; callers name keys without it. FlushAll deletes
// these keys only, so a Redis database shared with another application, or with keys Kubeast keeps for longer, keeps
// the rest.
const Prefix = "kubeast:cache:"

// MaxTTL is the longest the cache keeps an entry (the Helm list's generation mark). An entry set without a positive
// TTL is kept this long: nothing the cache writes stays in Redis for ever.
const MaxTTL = time.Hour

// Options is the connection New makes, for another client of the same Redis.
func Options(host string, port, db int, password string) *redis.Options {
	return &redis.Options{
		Addr:        fmt.Sprintf("%s:%d", host, port),
		Password:    password,
		DB:          db,
		DialTimeout: 5 * time.Second,
		ReadTimeout: 5 * time.Second,
	}
}

// New connects to Redis at host:port (password empty = no AUTH, the local
// docker/kind setups) and falls back to the in-memory cache when it is not
// reachable. An empty host is no Redis at all: the in-memory cache, no attempt.
func New(host string, port, db int, password string) *Cache {
	c := &Cache{
		mem: make(map[string]memEntry),
	}
	if host == "" {
		slog.Info("redis off (REDIS_HOST empty), using in-memory cache")
		return c
	}

	rdb := redis.NewClient(Options(host, port, db, password))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		slog.Warn("redis not available, using in-memory cache", "err", err)
		c.connected = false
	} else {
		slog.Info("redis connected", "addr", fmt.Sprintf("%s:%d", host, port))
		c.rdb = rdb
		c.connected = true
	}

	return c
}

// Get reads key into dest. A hit is noted for an AI tool call being recorded
// (accesstrail): the answer came from Kubeast's cache, not from the cluster.
func (c *Cache) Get(ctx context.Context, key string, dest interface{}) bool {
	if !c.get(ctx, key, dest) {
		return false
	}
	accesstrail.Cached(ctx, "cache "+cacheName(key))
	return true
}

// Peek reads key as Get does without noting a hit, for the cache's own bookkeeping, which no answer came from.
func (c *Cache) Peek(ctx context.Context, key string, dest interface{}) bool {
	return c.get(ctx, key, dest)
}

func (c *Cache) get(ctx context.Context, key string, dest interface{}) bool {
	if c.connected {
		data, err := c.rdb.Get(ctx, Prefix+key).Bytes()
		if err != nil {
			return false
		}
		if err := json.Unmarshal(data, dest); err != nil {
			return false
		}
		return true
	}

	c.mu.RLock()
	entry, ok := c.mem[key]
	c.mu.RUnlock()
	if !ok || time.Now().After(entry.expires) {
		if ok {
			c.mu.Lock()
			delete(c.mem, key)
			c.mu.Unlock()
		}
		return false
	}
	return json.Unmarshal(entry.data, dest) == nil
}

// Set keeps value under key for ttl; a ttl that is not positive keeps it for MaxTTL.
func (c *Cache) Set(ctx context.Context, key string, value interface{}, ttl time.Duration) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	if ttl <= 0 {
		ttl = MaxTTL
		c.noTTL.Do(func() {
			slog.Warn("cache: an entry set without a positive TTL is kept for the longest TTL", "key", cacheName(key), "ttl", MaxTTL)
		})
	}

	if c.connected {
		c.rdb.Set(ctx, Prefix+key, data, ttl)
		return
	}

	now := time.Now()
	c.mu.Lock()
	c.mem[key] = memEntry{data: data, expires: now.Add(ttl)}
	c.dropExpired(now)
	c.mu.Unlock()
}

// memSweepMin is how many entries the in-memory cache holds before Set looks for expired ones. Get drops only a key it
// is asked for, so a key nobody asks for again would stay. c.mu held.
const memSweepMin = 1024

func (c *Cache) dropExpired(now time.Time) {
	if len(c.mem) < c.memSweepAt || len(c.mem) < memSweepMin {
		return
	}
	for key, entry := range c.mem {
		if now.After(entry.expires) {
			delete(c.mem, key)
		}
	}
	// Twice what stayed: the sweep costs a walk of the map, so it cannot run on every Set of a full cache.
	c.memSweepAt = 2 * len(c.mem)
}

// invalidationTimeout bounds a delete that no longer ends with its request.
const invalidationTimeout = 5 * time.Second

// invalidationContext keeps a delete going after the request that caused it: the write has happened, so a browser gone
// meanwhile must not leave the old list in the cache.
func invalidationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), invalidationTimeout)
}

func (c *Cache) Delete(ctx context.Context, key string) {
	if c.connected {
		ctx, cancel := invalidationContext(ctx)
		defer cancel()
		c.rdb.Del(ctx, Prefix+key)
		return
	}
	c.mu.Lock()
	delete(c.mem, key)
	c.mu.Unlock()
}

func (c *Cache) DeletePattern(ctx context.Context, pattern string) {
	if c.connected {
		ctx, cancel := invalidationContext(ctx)
		defer cancel()
		iter := c.rdb.Scan(ctx, 0, Prefix+pattern, 100).Iterator()
		for iter.Next(ctx) {
			c.rdb.Del(ctx, iter.Val())
		}
		return
	}
	// One lock over the scan (a few ms at 100,000 keys, writes are rare); expired entries go too, as only a read of that key would remove them.
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, entry := range c.mem {
		if globMatch(pattern, key) || now.After(entry.expires) {
			delete(c.mem, key)
		}
	}
}

func (c *Cache) IsConnected() bool {
	return c.connected
}

// FlushAll drops every entry. Use sparingly — only when cached data may no
// longer reflect reality (e.g. after the underlying K8s cluster changes).
// In Redis it deletes the keys under Prefix and no other.
func (c *Cache) FlushAll(ctx context.Context) error {
	if c.connected {
		return flushPrefix(ctx, c.rdb)
	}
	c.mu.Lock()
	c.mem = make(map[string]memEntry)
	c.mu.Unlock()
	return nil
}

// flushBatch is how many keys one SCAN step asks for and one UNLINK removes.
const flushBatch = 1000

// flushPrefix unlinks the keys under Prefix, found by SCAN MATCH. A key written during the scan may stay, as one
// written right after a FLUSHDB would.
func flushPrefix(ctx context.Context, rdb *redis.Client) error {
	batch := make([]string, 0, flushBatch)
	unlink := func() error {
		if len(batch) == 0 {
			return nil
		}
		err := rdb.Unlink(ctx, batch...).Err()
		batch = batch[:0]
		return err
	}
	iter := rdb.Scan(ctx, 0, Prefix+"*", flushBatch).Iterator()
	for iter.Next(ctx) {
		batch = append(batch, iter.Val())
		if len(batch) == flushBatch {
			if err := unlink(); err != nil {
				return err
			}
		}
	}
	if err := iter.Err(); err != nil {
		return err
	}
	return unlink()
}

// cacheName is a key without its cluster and identity parts (k8s.Service
// clusterCacheKey writes "cluster|key|as:identity").
func cacheName(key string) string {
	if i := strings.Index(key, "|as:"); i != -1 {
		key = key[:i]
	}
	if i := strings.Index(key, "|"); i != -1 {
		key = key[i+1:]
	}
	return key
}
