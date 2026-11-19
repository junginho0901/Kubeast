package cache

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// silentRedis passes a cache's connections to a Redis stand-in until silence: from then on it answers nothing and
// keeps every connection open, old and new, as a Redis whose packets are dropped does (a Service with no endpoints
// behind a NetworkPolicy). sent counts the bytes that came from the cache meanwhile.
type silentRedis struct {
	ln     net.Listener
	to     string
	silent atomic.Bool
	sent   atomic.Int64
	mu     sync.Mutex
	conns  []net.Conn
}

func newSilentRedis(t *testing.T, to string) *silentRedis {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &silentRedis{ln: ln, to: to}
	t.Cleanup(func() {
		_ = ln.Close()
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, c := range s.conns {
			_ = c.Close()
		}
	})
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			s.keep(conn)
			go s.serve(conn)
		}
	}()
	return s
}

func (s *silentRedis) keep(c net.Conn) {
	s.mu.Lock()
	s.conns = append(s.conns, c)
	s.mu.Unlock()
}

func (s *silentRedis) serve(client net.Conn) {
	var up net.Conn
	if !s.silent.Load() {
		var err error
		if up, err = net.Dial("tcp", s.to); err != nil {
			return
		}
		s.keep(up)
		go s.pass(up, client, false)
	}
	s.pass(client, up, true)
}

// pass copies from into to while not silent; once silent what comes is dropped.
func (s *silentRedis) pass(from, to net.Conn, fromCache bool) {
	buf := make([]byte, 32<<10)
	for {
		n, err := from.Read(buf)
		if n > 0 {
			if s.silent.Load() || to == nil {
				if fromCache {
					s.sent.Add(int64(n))
				}
			} else if _, werr := to.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *silentRedis) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

// timed runs f and fails the test if it has not returned within limit.
func timed(t *testing.T, limit time.Duration, what string, f func()) time.Duration {
	t.Helper()
	start := time.Now()
	done := make(chan struct{})
	go func() { f(); close(done) }()
	select {
	case <-done:
		return time.Since(start)
	case <-time.After(limit):
		t.Fatalf("%s: no answer within %v", what, limit)
		return 0
	}
}

// A cache in Redis whose Redis stops answering (packets dropped, nothing refused): its read misses within a second,
// so a screen reads the cluster instead of waiting; a Helm list's four commands after it go nowhere near Redis.
func TestAReadMissesWithinASecondWhenRedisStopsAnswering(t *testing.T) {
	mr := miniredis.RunT(t)
	s := newSilentRedis(t, mr.Addr())
	c := New("127.0.0.1", s.port(), 0, "")
	if !c.IsConnected() {
		t.Fatal("not connected through the stand-in")
	}
	ctx := context.Background()
	c.Set(ctx, "k", "v", time.Minute)
	var got string
	if !c.Get(ctx, "k", &got) || got != "v" {
		t.Fatalf("a read before the outage: %q", got)
	}

	s.silent.Store(true)
	var hit bool
	took := timed(t, 3*time.Second, "a read while Redis does not answer", func() { hit = c.Get(ctx, "k", &got) })
	if hit {
		t.Fatal("a Redis that does not answer gave a hit")
	}
	if took > time.Second {
		t.Fatalf("a read waited %v for a Redis that does not answer", took)
	}

	sentBefore := s.sent.Load()
	took = timed(t, 3*time.Second, "a Helm list's commands after it", func() {
		var list []string
		var mark string
		c.Get(ctx, "helm|releases|x", &list)
		c.Peek(ctx, "helm|releases-generation", &mark)
		c.Set(ctx, "helm|releases|x", []string{"a"}, time.Minute)
		c.Peek(ctx, "helm|releases-generation", &mark)
	})
	if took > 100*time.Millisecond {
		t.Errorf("the commands after a read Redis did not answer took %v", took)
	}
	if n := s.sent.Load() - sentBefore; n != 0 {
		t.Errorf("%d bytes went to Redis right after a command it did not answer", n)
	}
	if !c.IsConnected() {
		t.Error("the cache left Redis: a Redis that answers again must be used again")
	}
}

// A dial whose packets are dropped is given up once, at its time limit: no second dial, no second try of the command
// (go-redis's defaults are five dials of 5 s each, for each of four tries).
func TestADroppedDialIsGivenUpOnceAtItsTimeLimit(t *testing.T) {
	var dials atomic.Int32
	opts := cacheOptions("10.0.0.1", 6379, 0, "", "")
	opts.Dialer = func(ctx context.Context, _, _ string) (net.Conn, error) {
		dials.Add(1)
		<-ctx.Done()
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: ctx.Err()}
	}
	rdb := redis.NewClient(opts)
	t.Cleanup(func() { _ = rdb.Close() })
	c := &Cache{mem: map[string]memEntry{}}
	c.rdb.Store(rdb)

	var got string
	took := timed(t, 5*time.Second, "a read on a dropped dial", func() { c.Get(context.Background(), "k", &got) })
	if took > time.Second {
		t.Errorf("a read on a dropped dial took %v", took)
	}
	if n := dials.Load(); n != 1 {
		t.Errorf("%d dials for one read, want 1", n)
	}
}
