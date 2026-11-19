package cache

import (
	"bufio"
	"context"
	"errors"
	"net"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// aclRedis is a Redis stand-in whose user may not run refuse (upper-case names): those are answered NOPERM as Redis 7
// words it, the rest as the cache expects.
func aclRedis(t *testing.T, refuse ...string) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				r := bufio.NewReader(conn)
				for {
					args, err := readCommand(r)
					if err != nil {
						return
					}
					name := strings.ToUpper(args[0])
					reply := "+OK\r\n"
					switch {
					case slices.Contains(refuse, name):
						reply = "-NOPERM User k8s-service has no permissions to run the '" + strings.ToLower(name) + "' command\r\n"
					case name == "HELLO":
						reply = "-ERR unknown command 'HELLO'\r\n"
					case name == "PING":
						reply = "+PONG\r\n"
					case name == "GET":
						reply = "$-1\r\n"
					case name == "DEL", name == "UNLINK", name == "PUBLISH":
						reply = ":1\r\n"
					}
					if _, err := conn.Write([]byte(reply)); err != nil {
						return
					}
				}
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// gatherRefusals reads c as a scrape would, by command, failing on a label other than service and command.
func gatherRefusals(t *testing.T, c *refusalCounts) map[string]float64 {
	t.Helper()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(c.refused)
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]float64{}
	for _, f := range families {
		for _, s := range f.GetMetric() {
			labels := map[string]string{}
			var names []string
			for _, l := range s.GetLabel() {
				labels[l.GetName()] = l.GetValue()
				names = append(names, l.GetName())
			}
			if f.GetName() != "kubeast_redis_refusals_total" || !slices.Equal(names, []string{"command", "service"}) || labels["service"] != "k8s" {
				t.Errorf("%s labelled %v", f.GetName(), labels)
			}
			got[labels["command"]] = s.GetCounter().GetValue()
		}
	}
	return got
}

// freshRefusals gives the clients made from here on counts of their own.
func freshRefusals(t *testing.T) *refusalCounts {
	t.Helper()
	was := refusals
	refusals = newRefusalCounts()
	t.Cleanup(func() { refusals = was })
	return refusals
}

// A store and a read the Redis user may not run are each counted under their command, and the cache goes on reading
// them as misses; what it may run, a delete here, counts nothing.
func TestCommandsRedisRefusesForTheUsersACLAreCountedByCommand(t *testing.T) {
	counts := freshRefusals(t)
	c := NewWithUser("127.0.0.1", aclRedis(t, "SET", "GET"), 0, "k8s-service", "pw")
	if !c.IsConnected() {
		t.Fatal("not connected to the stand-in")
	}
	ctx := context.Background()
	c.Set(ctx, "k:a", "v", time.Minute)
	var read string
	if c.Get(ctx, "k:a", &read) {
		t.Fatal("a refused read was a hit")
	}
	c.Delete(ctx, "k:a")
	if got := gatherRefusals(t, counts); len(got) != 2 || got["set"] != 1 || got["get"] != 1 {
		t.Fatalf("refusals %v, want set 1 and get 1", got)
	}
	if c.skipping() {
		t.Fatal("a refusal left Redis out as if it had not answered")
	}
}

// A refusal inside a pipeline is counted by its command; other Redis errors and errors of no Redis answer are not.
func TestOnlyNOPERMIsCountedAlsoInAPipeline(t *testing.T) {
	counts := newRefusalCounts()
	hook := refusalHook{counts}
	refused := redis.NewStringCmd(context.Background(), "get", "k")
	refused.SetErr(redisReply("NOPERM No permissions to access a key"))
	other := redis.NewStatusCmd(context.Background(), "set", "k", "v")
	other.SetErr(redisReply("WRONGTYPE Operation against a key holding the wrong kind of value"))
	cut := redis.NewIntCmd(context.Background(), "del", "k")
	cut.SetErr(errors.New("dial tcp: i/o timeout"))
	run := hook.ProcessPipelineHook(func(context.Context, []redis.Cmder) error { return refused.Err() })
	_ = run(context.Background(), []redis.Cmder{refused, other, cut})
	one := hook.ProcessHook(func(_ context.Context, cmd redis.Cmder) error { return cmd.Err() })
	_ = one(context.Background(), other)
	_ = one(context.Background(), cut)
	if got := gatherRefusals(t, counts); len(got) != 1 || got["get"] != 1 {
		t.Fatalf("refusals %v, want get 1 only", got)
	}
}

// redisReply is an error Redis sent, as go-redis gives it.
type redisReply string

func (e redisReply) Error() string { return string(e) }
func (redisReply) RedisError()     {}
