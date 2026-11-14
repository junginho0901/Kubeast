package main

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

// O-11: the boot wait for the database had no bound per ping (one pgxpool connect to a database that does not
// answer runs two minutes, so "30 pings" was not 60 s) and slept through SIGTERM. The chart's startup probe gives
// the whole boot 180 s.

type bootPinger struct {
	mu        sync.Mutex
	calls     int
	deadlines []time.Duration // time left on each ping's context, -1 for none
	hang      bool            // block until the ping's context ends
	pinged    chan struct{}
}

func (p *bootPinger) Ping(ctx context.Context) error {
	p.mu.Lock()
	p.calls++
	left := time.Duration(-1)
	if d, ok := ctx.Deadline(); ok {
		left = time.Until(d)
	}
	p.deadlines = append(p.deadlines, left)
	first := p.calls == 1
	p.mu.Unlock()
	if first && p.pinged != nil {
		close(p.pinged)
	}
	if p.hang {
		<-ctx.Done()
		return ctx.Err()
	}
	return errors.New("connection refused")
}

// waitDone runs waitForDatabase and gives its answer, or fails the test when it does not return within limit.
func waitDone(t *testing.T, limit time.Duration, run func() error) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- run() }()
	select {
	case err := <-done:
		return err
	case <-time.After(limit):
		t.Fatalf("the wait did not return within %v", limit)
		return nil
	}
}

func TestWaitForDatabaseGivesEachPingItsOwnFiveSeconds(t *testing.T) {
	p := &bootPinger{pinged: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-p.pinged; cancel() }()
	_ = waitDone(t, 5*time.Second, func() error { return waitForDatabase(ctx, p, dbBootWait) })
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.deadlines) == 0 || p.deadlines[0] <= 0 || p.deadlines[0] > 5*time.Second {
		t.Fatalf("time left on the first ping's context = %v, want at most 5s", p.deadlines)
	}
}

func TestWaitForDatabaseEndsWhenItsContextEnds(t *testing.T) {
	p := &bootPinger{pinged: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	cancelled := make(chan time.Time, 1)
	go func() { <-p.pinged; cancelled <- time.Now(); cancel() }()
	err := waitDone(t, 5*time.Second, func() error { return waitForDatabase(ctx, p, dbBootWait) })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if after := time.Since(<-cancelled); after > 500*time.Millisecond {
		t.Fatalf("returned %v after the context ended, want at once (SIGTERM during the boot wait)", after)
	}
}

func TestWaitForDatabaseStopsAtItsWaitWhenAPingHangs(t *testing.T) {
	p := &bootPinger{hang: true}
	err := waitDone(t, 3*time.Second, func() error { return waitForDatabase(context.Background(), p, 300*time.Millisecond) })
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}
}

func TestWaitForDatabaseReturnsWhenTheDatabaseAnswers(t *testing.T) {
	if err := waitForDatabase(context.Background(), answeringPinger{}, dbBootWait); err != nil {
		t.Fatalf("err = %v", err)
	}
}

type answeringPinger struct{}

func (answeringPinger) Ping(context.Context) error { return nil }

// silentDatabase accepts connections and never answers, as a database behind a dropped route or a hung server.
func silentDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}
	}()
	// pgxpool's own connect timeout stays at its default (two minutes), as in the service
	cfg, err := pgxpool.ParseConfig("postgres://kubeast:pw@" + ln.Addr().String() + "/kubeast?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	t.Cleanup(func() { // first: a connect still waiting ends on the closed socket, so pool.Close does not wait for it
		_ = ln.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			_ = c.Close()
		}
	})
	return pool
}

func TestWaitForDatabaseCutsAPoolConnectNoOneAnswers(t *testing.T) {
	t.Parallel()
	pool := silentDatabase(t)
	start := time.Now()
	err := waitDone(t, 10*time.Second, func() error { return waitForDatabase(context.Background(), pool, time.Second) })
	if err == nil {
		t.Fatal("a database that never answers was taken as ready")
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("took %v for a 1s wait", took)
	}
}

func TestWaitForSchemaCutsAVersionReadNoOneAnswers(t *testing.T) {
	t.Parallel()
	pool := silentDatabase(t)
	start := time.Now()
	err := waitDone(t, 15*time.Second, func() error { return waitForSchema(context.Background(), pool, 100*time.Millisecond) })
	if !errors.Is(err, dbmigrate.ErrBehind) {
		t.Fatalf("err = %v, want dbmigrate.ErrBehind", err)
	}
	if took := time.Since(start); took > 8*time.Second {
		t.Fatalf("took %v for a 100ms wait (5s past it at most)", took)
	}
}
