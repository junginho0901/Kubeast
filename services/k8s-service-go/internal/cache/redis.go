package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cache provides Redis caching with in-memory fallback.
type Cache struct {
	rdb       *redis.Client
	connected bool

	mu      sync.RWMutex
	mem     map[string]memEntry
	memOnce sync.Once
}

type memEntry struct {
	data    []byte
	expires time.Time
}

func New(host string, port, db int) *Cache {
	c := &Cache{
		mem: make(map[string]memEntry),
	}

	rdb := redis.NewClient(&redis.Options{
		Addr:        fmt.Sprintf("%s:%d", host, port),
		DB:          db,
		DialTimeout: 5 * time.Second,
		ReadTimeout: 5 * time.Second,
	})

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

func (c *Cache) Get(ctx context.Context, key string, dest interface{}) bool {
	if c.connected {
		data, err := c.rdb.Get(ctx, key).Bytes()
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

func (c *Cache) Set(ctx context.Context, key string, value interface{}, ttl time.Duration) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}

	if c.connected {
		c.rdb.Set(ctx, key, data, ttl)
		return
	}

	c.mu.Lock()
	c.mem[key] = memEntry{data: data, expires: time.Now().Add(ttl)}
	c.mu.Unlock()
}

func (c *Cache) Delete(ctx context.Context, key string) {
	if c.connected {
		c.rdb.Del(ctx, key)
		return
	}
	c.mu.Lock()
	delete(c.mem, key)
	c.mu.Unlock()
}

func (c *Cache) DeletePattern(ctx context.Context, pattern string) {
	if c.connected {
		iter := c.rdb.Scan(ctx, 0, pattern, 100).Iterator()
		for iter.Next(ctx) {
			c.rdb.Del(ctx, iter.Val())
		}
		return
	}
	// In-memory: no pattern matching, skip
}

func (c *Cache) IsConnected() bool {
	return c.connected
}

// FlushAll drops every entry. Use sparingly — only when cached data may no
// longer reflect reality (e.g. after the underlying K8s cluster changes).
func (c *Cache) FlushAll(ctx context.Context) error {
	if c.connected {
		return c.rdb.FlushDB(ctx).Err()
	}
	c.mu.Lock()
	c.mem = make(map[string]memEntry)
	c.mu.Unlock()
	return nil
}
