package cache

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// aclKeys is the key pattern of the chart's Redis user k8s-service (kubeast.redisUsersAcl, ~kubeast:*): Valkey refuses
// a command of that user naming any other key.
const aclKeys = "kubeast:*"

// sentCommands records the arguments of every command a client sends.
type sentCommands struct {
	mu   sync.Mutex
	args [][]interface{}
}

func (s *sentCommands) DialHook(next redis.DialHook) redis.DialHook { return next }

func (s *sentCommands) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		s.add(cmd)
		return next(ctx, cmd)
	}
}

func (s *sentCommands) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		for _, cmd := range cmds {
			s.add(cmd)
		}
		return next(ctx, cmds)
	}
}

func (s *sentCommands) add(cmd redis.Cmder) {
	s.mu.Lock()
	s.args = append(s.args, cmd.Args())
	s.mu.Unlock()
}

// keysOutsideACL lists each command recorded that names a key outside aclKeys, or that may reach one: a SCAN whose
// MATCH does not start with "kubeast:" returns keys the deletes after it would name.
func (s *sentCommands) keysOutsideACL(t *testing.T) (outside []string, seen map[string]int) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	seen = map[string]int{}
	for _, args := range s.args {
		name := strings.ToLower(fmt.Sprint(args[0]))
		seen[name]++
		var keys []string
		switch name {
		case "get", "set":
			keys = []string{fmt.Sprint(args[1])}
		case "del", "unlink":
			for _, a := range args[1:] {
				keys = append(keys, fmt.Sprint(a))
			}
		case "scan":
			match := ""
			for i := 2; i+1 < len(args); i++ {
				if strings.EqualFold(fmt.Sprint(args[i]), "match") {
					match = fmt.Sprint(args[i+1])
				}
			}
			if !strings.HasPrefix(match, "kubeast:") {
				outside = append(outside, fmt.Sprintf("SCAN MATCH %q", match))
			}
		case "ping", "select":
		case "hello", "auth", "client":
			// a new connection's set-up: HELLO and AUTH take no ACL rule; CLIENT SETINFO and CLIENT
			// MAINT_NOTIFICATIONS are refused, which go-redis ignores
		default:
			t.Errorf("the cache sent %v, a command the test does not know the keys of", args)
		}
		for _, k := range keys {
			if !globMatch(aclKeys, k) {
				outside = append(outside, fmt.Sprintf("%s %q", strings.ToUpper(name), k))
			}
		}
	}
	return outside, seen
}

// callerKeys are keys as callers name them: none starts with kubeast:, some hold glob characters.
var callerKeys = []string{"prod|pods|as:0123abcd", "helm|releases-generation", "", "*", "other-app:key", "[x]?"}

// Every key the cache sends to Redis — written, read, deleted, deleted by pattern, flushed — starts with kubeast:, so
// the chart's ACL (~kubeast:*) never refuses one, whatever key the caller named.
func TestEveryKeyTheCacheSendsIsWithinTheACLKeyPattern(t *testing.T) {
	mr := miniredis.RunT(t)
	c := cacheOn(t, mr)
	sent := &sentCommands{}
	c.rdb.Load().AddHook(sent)
	c.inv.AddHook(sent) // the invalidations' client
	ctx := context.Background()
	for _, k := range callerKeys {
		c.Set(ctx, k, 1, time.Minute)
		c.Set(ctx, k, 1, 0) // MaxTTL
		var got int
		c.Get(ctx, k, &got)
		c.Peek(ctx, k, &got)
	}
	for _, k := range callerKeys {
		c.Delete(ctx, k)
		c.DeletePattern(ctx, k)
	}
	for _, k := range callerKeys {
		c.Set(ctx, k, 1, time.Minute)
	}
	c.DeletePattern(ctx, "prod|*")
	if err := c.FlushAll(ctx); err != nil {
		t.Fatal(err)
	}

	outside, seen := sent.keysOutsideACL(t)
	if len(outside) > 0 {
		t.Fatalf("keys outside %s: %v", aclKeys, outside)
	}
	for _, name := range []string{"set", "get", "del", "scan", "unlink"} {
		if seen[name] == 0 {
			t.Fatalf("no %s sent; the test did not go through every path (sent %v)", strings.ToUpper(name), seen)
		}
	}
	for _, k := range mr.Keys() {
		t.Fatalf("key %q stayed after FlushAll", k)
	}
}

// The flush a cache owes for a change taken in memory, done when it moves to Redis, names keys within the ACL's
// pattern as well.
func TestTheOwedFlushOnReconnectIsWithinTheACLKeyPattern(t *testing.T) {
	mr, c := downRedis(t)
	sent := &sentCommands{}
	c.standby.AddHook(sent)
	ctx := context.Background()
	c.Set(ctx, "prod|mine", 1, time.Minute)
	if err := c.FlushAll(ctx); err != nil {
		t.Fatal(err)
	}
	done := reconnect(t, c)
	if err := mr.Set(Prefix+"prod|cluster_overview|as:x", "1"); err != nil {
		t.Fatal(err)
	}
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
	within(t, 5*time.Second, c.IsConnected)
	<-done
	c.Set(ctx, "prod|after", 2, time.Minute)

	outside, seen := sent.keysOutsideACL(t)
	if len(outside) > 0 {
		t.Fatalf("keys outside %s: %v", aclKeys, outside)
	}
	if seen["scan"] == 0 || seen["unlink"] == 0 {
		t.Fatalf("the owed flush sent no SCAN or UNLINK (sent %v)", seen)
	}
}
