package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// Cache provides Redis caching with in-memory fallback.
type Cache struct {
	// rdb is the Redis the cache is in; nil = the map below. standby is the client of a Redis that did not answer at
	// start, asked again by Reconnect, which moves the cache there once it answers.
	rdb     atomic.Pointer[redis.Client]
	standby *redis.Client
	// owed: FlushAll emptied the map while a Redis was set up but not in use, so the cache in that Redis, which other
	// replicas read, was not flushed. Reconnect flushes it when it moves there.
	owed atomic.Bool
	// noTTL logs once that an entry came without a positive TTL (Set).
	noTTL sync.Once
	// skipUntil (UnixNano, 0 = none): a command Redis did not answer leaves Redis out of reads and stores until then,
	// skipFor after it, and they miss (useRedis).
	skipUntil atomic.Int64
	skipFor   time.Duration

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

// Options is a connection to the cache's Redis signing in as the cache does, for another client of it (the cluster
// change notices). The cache's own client waits less (cacheOptions).
func Options(host string, port, db int, username, password string) *redis.Options {
	return &redis.Options{
		Addr:        fmt.Sprintf("%s:%d", host, port),
		Username:    username,
		Password:    password,
		DB:          db,
		DialTimeout: 5 * time.Second,
		ReadTimeout: 5 * time.Second,
	}
}

// cacheTimeout bounds a cache command's dial, its wait for a connection of the pool and its write and read: a Redis in
// the cluster answers in a millisecond or two, so a command it has not answered by then misses, and the request reads
// the cluster.
const cacheTimeout = 500 * time.Millisecond

// redisSkip is how long reads and stores leave Redis out after a command it did not answer.
const redisSkip = 3 * time.Second

// cacheOptions is Options for the cache's client: one dial, no second try of a command, each step within cacheTimeout.
// go-redis's defaults (5 dials, 3 more tries) kept a Helm list waiting more than 30 s on a Redis whose packets were
// dropped.
func cacheOptions(host string, port, db int, username, password string) *redis.Options {
	o := Options(host, port, db, username, password)
	o.DialTimeout = cacheTimeout
	o.DialerRetries = 1
	o.PoolTimeout = cacheTimeout
	o.ReadTimeout = cacheTimeout
	o.WriteTimeout = cacheTimeout
	o.MaxRetries = -1
	return o
}

// New connects to Redis at host:port (password empty = no AUTH, the local
// docker/kind setups) and falls back to the in-memory cache when it is not
// reachable. An empty host is no Redis at all: the in-memory cache, no attempt.
func New(host string, port, db int, password string) *Cache {
	return NewWithUser(host, port, db, "", password)
}

// NewWithUser is New signing in as a Redis ACL user (REDIS_USERNAME, the chart's redis.acl); an empty username signs
// in with the password alone, as New does.
func NewWithUser(host string, port, db int, username, password string) *Cache {
	c := &Cache{
		mem:     make(map[string]memEntry),
		skipFor: redisSkip,
	}
	if host == "" {
		slog.Info("redis off (REDIS_HOST empty), using in-memory cache")
		return c
	}

	rdb := redis.NewClient(cacheOptions(host, port, db, username, password))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		slog.Warn("redis not available, using in-memory cache until it answers", "err", err)
		c.standby = rdb
	} else {
		slog.Info("redis connected", "addr", fmt.Sprintf("%s:%d", host, port))
		c.rdb.Store(rdb)
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
	if rdb := c.rdb.Load(); rdb != nil {
		if !c.useRedis() {
			return false
		}
		data, err := rdb.Get(ctx, Prefix+key).Bytes()
		c.answered(ctx, err)
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
	c.set(ctx, key, value, ttl, false)
}

// Mark is Set for what an invalidation writes (the Helm list's generation mark): like Delete, it goes to Redis also
// while reads and stores leave Redis out.
func (c *Cache) Mark(ctx context.Context, key string, value interface{}, ttl time.Duration) {
	c.set(ctx, key, value, ttl, true)
}

func (c *Cache) set(ctx context.Context, key string, value interface{}, ttl time.Duration, always bool) {
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

	if rdb := c.rdb.Load(); rdb != nil {
		if always || c.useRedis() {
			c.answered(ctx, rdb.Set(ctx, Prefix+key, data, ttl).Err())
		}
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
	if rdb := c.rdb.Load(); rdb != nil {
		ctx, cancel := invalidationContext(ctx)
		defer cancel()
		c.answered(ctx, rdb.Del(ctx, Prefix+key).Err())
		return
	}
	c.mu.Lock()
	delete(c.mem, key)
	c.mu.Unlock()
}

func (c *Cache) DeletePattern(ctx context.Context, pattern string) {
	if rdb := c.rdb.Load(); rdb != nil {
		ctx, cancel := invalidationContext(ctx)
		defer cancel()
		iter := rdb.Scan(ctx, 0, Prefix+pattern, 100).Iterator()
		for iter.Next(ctx) {
			rdb.Del(ctx, iter.Val())
		}
		c.answered(ctx, iter.Err())
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
	return c.rdb.Load() != nil
}

// useRedis is whether a read or store goes to Redis now: not until skipUntil. Once that has passed one caller tries
// Redis, and the others leave it out until that try ends (answered).
func (c *Cache) useRedis() bool {
	until := c.skipUntil.Load()
	if until == 0 {
		return true
	}
	now := time.Now().UnixNano()
	return now >= until && c.skipUntil.CompareAndSwap(until, now+int64(c.skipFor))
}

// answered ends the skip when Redis answered the command (a miss and an error Redis sent count) and starts it when it
// did not; a command whose own context ended says nothing about Redis.
func (c *Cache) answered(ctx context.Context, err error) {
	var fromRedis redis.Error
	if err == nil || errors.As(err, &fromRedis) {
		if c.skipUntil.Load() != 0 && c.skipUntil.Swap(0) != 0 {
			slog.Info("redis answers the cache again")
		}
		return
	}
	if ctx.Err() != nil {
		return
	}
	if c.skipUntil.Swap(time.Now().Add(c.skipFor).UnixNano()) == 0 {
		slog.Warn("redis did not answer the cache; reads and stores leave it out and ask the cluster", "err", err, "for", c.skipFor)
	}
}

// Reconnect, for a cache whose Redis did not answer at start, asks Redis every interval until it answers and then
// moves the cache there: the map is dropped, and the flush owed for changes taken meanwhile (FlushAll) is done in
// Redis. It returns then, or when ctx ends, and at once for a cache in Redis or with no Redis set up.
func (c *Cache) Reconnect(ctx context.Context, every time.Duration) {
	if c.standby == nil || c.IsConnected() {
		return
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for !c.moveToRedis(ctx) {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// moveToRedis moves the cache to the standby Redis if it answers.
func (c *Cache) moveToRedis(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := c.standby.Ping(ctx).Err(); err != nil {
		return false
	}
	c.rdb.Store(c.standby)
	c.mu.Lock()
	c.mem = make(map[string]memEntry)
	c.mu.Unlock()
	owed := c.owed.Swap(false)
	slog.Info("redis answered, the cache moves there from memory", "addr", c.standby.Options().Addr, "flush_owed", owed)
	if owed {
		if err := flushPrefix(ctx, c.standby); err != nil {
			slog.Warn("cache: flush owed for changes taken while in memory failed; those entries end with their TTL", "err", err)
		}
	}
	return true
}

// FlushAll drops every entry. Use sparingly — only when cached data may no
// longer reflect reality (e.g. after the underlying K8s cluster changes).
// In Redis it deletes the keys under Prefix and no other.
func (c *Cache) FlushAll(ctx context.Context) error {
	if rdb := c.rdb.Load(); rdb != nil {
		err := flushPrefix(ctx, rdb)
		c.answered(ctx, err)
		return err
	}
	c.mu.Lock()
	c.mem = make(map[string]memEntry)
	c.mu.Unlock()
	if c.standby != nil {
		c.owed.Store(true)
		// moved to Redis meanwhile, past its look at owed
		if rdb := c.rdb.Load(); rdb != nil && c.owed.Swap(false) {
			return flushPrefix(ctx, rdb)
		}
	}
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
