package cache

import (
	"bufio"
	"context"
	"net"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/redisacl"
)

// chartHelpers holds the chart's Redis users (kubeast.redisUsersAcl).
const chartHelpers = "../../../../helm/kubeast/templates/_helpers.tpl"

// commandRecorder is a Redis stand-in that answers every command the cache may send and records each one's name. It
// refuses HELLO, as a server without RESP3 does, so the client signs in with AUTH; a SCAN finds one key, so a delete by
// pattern sends its delete too.
type commandRecorder struct {
	ln   net.Listener
	mu   sync.Mutex
	seen []string
}

func newCommandRecorder(t *testing.T) *commandRecorder {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &commandRecorder{ln: ln}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(conn)
		}
	}()
	return s
}

func (s *commandRecorder) serve(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	for {
		args, err := readCommand(r)
		if err != nil {
			return
		}
		name := strings.ToUpper(args[0])
		s.mu.Lock()
		s.seen = append(s.seen, name)
		s.mu.Unlock()
		reply := "+OK\r\n"
		switch name {
		case "HELLO":
			reply = "-ERR unknown command 'HELLO'\r\n"
		case "PING":
			reply = "+PONG\r\n"
		case "GET":
			reply = "$-1\r\n"
		case "DEL", "UNLINK", "PUBLISH", "EXISTS", "EXPIRE":
			reply = ":1\r\n"
		case "SCAN":
			reply = "*2\r\n$1\r\n0\r\n*1\r\n$12\r\nkubeast:k:x1\r\n"
		}
		if _, err := conn.Write([]byte(reply)); err != nil {
			return
		}
	}
}

func (s *commandRecorder) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

func (s *commandRecorder) sent() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.seen...)
}

// Every command the cache sends to Redis is one the chart's Redis user k8s-service may run: in an install with
// redis.acl Redis refuses any other with NOPERM, which the cache reads as a miss, so the cache would read empty without
// an error. Each exported method of Cache runs once against the stand-in, on database 3 (SELECT), and a method this
// table does not run fails the test; the commands recorded are held to that user's line in the chart's helpers.
func TestTheCachesRedisCommandsAreThoseItsChartUserMayRun(t *testing.T) {
	s := newCommandRecorder(t)
	c := NewWithUser("127.0.0.1", s.port(), 3, "k8s-service", "pw-k8s")
	if !c.IsConnected() {
		t.Fatal("not connected to the stand-in")
	}
	ctx := context.Background()
	var read map[string]string
	run := map[string]func(){
		"Get":           func() { c.Get(ctx, "k:x1", &read) },
		"Peek":          func() { c.Peek(ctx, "k:x1", &read) },
		"Set":           func() { c.Set(ctx, "k:x1", map[string]string{"a": "b"}, time.Minute) },
		"Mark":          func() { c.Mark(ctx, "k:x1", "m", time.Minute) },
		"Delete":        func() { c.Delete(ctx, "k:x1") },
		"DeletePattern": func() { c.DeletePattern(ctx, "k:*") },
		"IsConnected":   func() { c.IsConnected() },
		"FlushAll":      func() { _ = c.FlushAll(ctx) },
		"Reconnect":     func() { c.Reconnect(ctx, time.Millisecond) },
	}
	typ := reflect.TypeOf(c)
	for i := 0; i < typ.NumMethod(); i++ {
		if name := typ.Method(i).Name; run[name] == nil {
			t.Errorf("Cache.%s is not run here: add it to this table, so what it sends to Redis is held to the chart's Redis user", name)
		}
	}
	names := make([]string, 0, len(run))
	for name := range run {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		run[name]()
	}

	allowed, err := redisacl.Commands(chartHelpers, "k8s-service")
	if err != nil {
		t.Fatal(err)
	}
	if refused := redisacl.Refused(s.sent(), allowed); len(refused) > 0 {
		t.Fatalf("the cache sends %s, which the chart's Redis user k8s-service does not allow: add it to that user's line in helm/kubeast/templates/_helpers.tpl (kubeast.redisUsersAcl) with a case in tests/redis_test.yaml, or send a command the line allows (sent: %v)",
			strings.Join(refused, ", "), s.sent())
	}
}
