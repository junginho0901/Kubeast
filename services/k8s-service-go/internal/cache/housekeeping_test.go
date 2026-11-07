package cache

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestSettingAKeyLetsGoOfExpiredOnes(t *testing.T) {
	c := New("", 0, 0, "")
	ctx := context.Background()
	for i := range 3000 {
		c.Set(ctx, fmt.Sprintf("old-%d", i), "x", time.Nanosecond)
	}
	time.Sleep(5 * time.Millisecond)
	for i := range 3000 {
		c.Set(ctx, fmt.Sprintf("new-%d", i), "x", time.Minute)
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	for key := range c.mem {
		if len(key) > 3 && key[:3] == "old" {
			t.Fatalf("expired keys stayed: %d entries, %s among them", len(c.mem), key)
		}
	}
	if len(c.mem) != 3000 {
		t.Fatalf("entries = %d, want the 3000 still valid", len(c.mem))
	}
}

func TestSettingKeepsWhatIsStillValid(t *testing.T) {
	c := New("", 0, 0, "")
	ctx := context.Background()
	c.Set(ctx, "keep", "v", time.Minute)
	for i := range 5000 {
		c.Set(ctx, fmt.Sprintf("old-%d", i), "x", time.Nanosecond)
	}
	var got string
	if !c.Get(ctx, "keep", &got) || got != "v" {
		t.Fatalf("got %q", got)
	}
}

// ctxSeen answers every command itself and keeps what context each came with.
type ctxSeen struct {
	mu   sync.Mutex
	errs map[string]error
}

func (s *ctxSeen) DialHook(next redis.DialHook) redis.DialHook { return next }
func (s *ctxSeen) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func (s *ctxSeen) ProcessHook(redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.errs[cmd.Name()] = ctx.Err()
		return nil
	}
}

func onRedis() (*Cache, *ctxSeen) {
	seen := &ctxSeen{errs: map[string]error{}}
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	rdb.AddHook(seen)
	return &Cache{rdb: rdb, connected: true, mem: map[string]memEntry{}}, seen
}

func TestInvalidationOutlivesTheRequestThatAskedForIt(t *testing.T) {
	c, seen := onRedis()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	c.Delete(ctx, "k")
	c.DeletePattern(ctx, "list:*")

	for _, name := range []string{"del", "scan"} {
		err, asked := seen.errs[name]
		if !asked {
			t.Fatalf("%s was not sent: %v", name, seen.errs)
		}
		if err != nil {
			t.Errorf("%s went out with a finished context: %v", name, err)
		}
	}
}

func TestReadsStillEndWithTheirRequest(t *testing.T) {
	c, seen := onRedis()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var got string
	c.Get(ctx, "k", &got)
	if err := seen.errs["get"]; err == nil {
		t.Fatal("a read went on after its request ended")
	}
}
