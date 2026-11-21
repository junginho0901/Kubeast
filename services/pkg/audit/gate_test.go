package audit

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakePinger struct {
	err   error
	calls int
}

func (p *fakePinger) Ping(ctx context.Context) error {
	p.calls++
	return p.err
}

// fakeStore (stdout_test.go) stands in for the Postgres store.

func TestGuardedReadyCachesThePing(t *testing.T) {
	p := &fakePinger{}
	g := Guard(&fakeStore{id: 1}, p, true)
	for i := 0; i < 3; i++ {
		if err := g.Ready(context.Background()); err != nil {
			t.Fatalf("ready: %v", err)
		}
	}
	if p.calls != 1 {
		t.Fatalf("ping calls = %d, want 1 (cached)", p.calls)
	}
	g.ttl = 0
	p.err = errors.New("dial tcp: connection refused")
	err := g.Ready(context.Background())
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("err should carry the ping error: %v", err)
	}
}

func TestGuardedFailClosedOffAlwaysReady(t *testing.T) {
	p := &fakePinger{err: errors.New("down")}
	g := Guard(&fakeStore{id: 1}, p, false)
	if err := g.Ready(context.Background()); err != nil {
		t.Fatalf("fail-closed off must not refuse: %v", err)
	}
	if p.calls != 0 {
		t.Fatalf("fail-closed off must not ping, got %d calls", p.calls)
	}
}

func TestGuardedWriteCountsFailuresAndDropsTheCache(t *testing.T) {
	p := &fakePinger{}
	st := &fakeStore{id: 1}
	g := Guard(st, p, true)
	if err := g.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	st.err = errors.New("insert: server closed the connection")
	if _, err := g.Write(context.Background(), Record{Action: "k8s.pod.delete"}); err == nil {
		t.Fatal("write should fail")
	}
	s := g.Status(context.Background())
	if s.WriteFailures != 1 || !strings.Contains(s.LastError, "server closed") || s.LastErrorAt == nil {
		t.Fatalf("status = %+v", s)
	}
	// The failure invalidated the cached ping: the next Ready pings again
	// (Status above pinged once itself, so three in total).
	p.err = errors.New("down")
	if err := g.Ready(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("after a write failure Ready must re-ping: %v", err)
	}
	if p.calls != 3 {
		t.Fatalf("ping calls = %d, want 3", p.calls)
	}
}

func TestRequireWritableRefusesMutationsOnly(t *testing.T) {
	p := &fakePinger{err: errors.New("down")}
	g := Guard(&fakeStore{id: 1}, p, true)
	g.ttl = 0
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := RequireWritable(g, "/api/v1/search")(ok)

	cases := []struct {
		method, path string
		want         int
	}{
		{http.MethodGet, "/api/v1/namespaces", http.StatusOK},
		{http.MethodPost, "/api/v1/search", http.StatusOK},
		{http.MethodPost, "/api/v1/resources/yaml/create", http.StatusServiceUnavailable},
		{http.MethodDelete, "/api/v1/namespaces/default/pods/x", http.StatusServiceUnavailable},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(c.method, c.path, nil))
		if rec.Code != c.want {
			t.Errorf("%s %s = %d, want %d", c.method, c.path, rec.Code, c.want)
		}
		if c.want == http.StatusServiceUnavailable && !strings.Contains(rec.Body.String(), "audit unavailable") {
			t.Errorf("%s %s body = %s", c.method, c.path, rec.Body.String())
		}
	}

	p.err = nil
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/namespaces/default/pods/x", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("store back: %d, want 200", rec.Code)
	}
}

func TestWaitReadyRetriesThenGivesUp(t *testing.T) {
	p := &fakePinger{err: errors.New("down")}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	err := WaitReady(ctx, p, 10*time.Millisecond)
	if err == nil || !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "down") {
		t.Fatalf("err = %v", err)
	}
	if p.calls < 2 {
		t.Fatalf("expected retries, got %d calls", p.calls)
	}

	p = &fakePinger{}
	if err := WaitReady(context.Background(), p, time.Millisecond); err != nil || p.calls != 1 {
		t.Fatalf("ready store: err=%v calls=%d", err, p.calls)
	}
}

func TestEnvSwitches(t *testing.T) {
	t.Setenv("AUDIT_FAIL_CLOSED", "")
	if !FailClosedEnabled() {
		t.Fatal("default must be fail-closed")
	}
	t.Setenv("AUDIT_FAIL_CLOSED", "false")
	if FailClosedEnabled() {
		t.Fatal("false must switch it off")
	}
	t.Setenv("AUDIT_DB_WAIT_SEC", "")
	if BootWait() != 90*time.Second {
		t.Fatalf("default wait = %v", BootWait())
	}
	t.Setenv("AUDIT_DB_WAIT_SEC", "15")
	if BootWait() != 15*time.Second {
		t.Fatalf("wait = %v", BootWait())
	}
}

// probingPinger answers pings and probes a write.
type probingPinger struct {
	fakePinger
	probeErr error
	probes   int
}

func (p *probingPinger) ProbeWrite(context.Context) error {
	p.probes++
	return p.probeErr
}

// A store that answers pings but takes no row: after a failed write, Ready
// probes a write and refuses until one lands; a write that lands clears it;
// with fail-closed off nothing is refused.
func TestGuardedProbesAWriteAfterAFailedWrite(t *testing.T) {
	ctx := context.Background()
	p := &probingPinger{}
	store := &fakeStore{id: 1}
	g := Guard(store, p, true)
	if err := g.Ready(ctx); err != nil || p.probes != 0 {
		t.Fatalf("healthy: %v probes %d (no probe before a failure)", err, p.probes)
	}

	store.err = errors.New("disk full")
	_, _ = g.Write(ctx, Record{Action: "x"})
	p.probeErr = errors.New("disk full")
	if err := g.Ready(ctx); !errors.Is(err, ErrUnavailable) || p.probes != 1 {
		t.Fatalf("after a failed write: %v probes %d", err, p.probes)
	}
	if err := g.Ready(ctx); !errors.Is(err, ErrUnavailable) || p.probes != 1 {
		t.Fatalf("within the window: cached refusal, %v probes %d", err, p.probes)
	}

	g.ttl = 0
	p.probeErr = nil
	if err := g.Ready(ctx); err != nil || p.probes != 2 {
		t.Fatalf("probe lands: ready again, %v probes %d", err, p.probes)
	}
	if err := g.Ready(ctx); err != nil || p.probes != 2 {
		t.Fatalf("no more probes once healthy: %v probes %d", err, p.probes)
	}

	_, _ = g.Write(ctx, Record{Action: "x"}) // fails again
	store.err = nil
	_, _ = g.Write(ctx, Record{Action: "y"}) // lands
	if err := g.Ready(ctx); err != nil || p.probes != 2 {
		t.Fatalf("a landed write clears it without a probe: %v probes %d", err, p.probes)
	}

	off := Guard(&fakeStore{id: 1, err: errors.New("x")}, &probingPinger{probeErr: errors.New("x")}, false)
	_, _ = off.Write(ctx, Record{Action: "x"})
	if err := off.Ready(ctx); err != nil {
		t.Fatalf("fail-closed off: %v", err)
	}
}

type requestKey struct{}

// ctxStore refuses a write on an ended context, as the Postgres store does
// (pgxpool's Acquire answers ctx.Err() before it takes a connection), and keeps
// what the write's context carried. With block set it waits for the context to
// end, with hold for that long or until the context ends; started, when set, is
// closed as the write begins.
type ctxStore struct {
	fakeStore
	block       bool
	hold        time.Duration
	started     chan struct{}
	rows        []Record
	deadline    time.Time
	hasDeadline bool
	value       any
}

func (s *ctxStore) Write(ctx context.Context, rec Record) (int64, error) {
	if s.started != nil {
		close(s.started)
	}
	if s.block {
		<-ctx.Done()
	} else if s.hold > 0 {
		select {
		case <-ctx.Done():
		case <-time.After(s.hold):
		}
	}
	if err := ctx.Err(); err != nil {
		return 0, fmt.Errorf("audit insert: %w", err)
	}
	s.deadline, s.hasDeadline = ctx.Deadline()
	s.value = ctx.Value(requestKey{})
	s.rows = append(s.rows, rec)
	return int64(len(s.rows)), nil
}

// A request whose client went away after its change ran: the row is stored
// with the request's values, with no deadline since the request had none, and
// the store is not counted as failing or marked broken.
func TestGuardedWriteOutlivesItsCallersCancellation(t *testing.T) {
	store := &ctxStore{}
	p := &probingPinger{probeErr: errors.New("probe refused")}
	g := Guard(store, p, true)
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), requestKey{}, "req-1"))
	cancel()

	id, err := g.Write(ctx, Record{Action: "k8s.pod.delete"})
	if err != nil || id != 1 || len(store.rows) != 1 || store.rows[0].Action != "k8s.pod.delete" {
		t.Fatalf("write after the caller left: id %d err %v rows %+v", id, err, store.rows)
	}
	if store.value != "req-1" {
		t.Fatalf("the write lost the request's values: %v", store.value)
	}
	if store.hasDeadline {
		t.Fatalf("write deadline = %v, want none: the caller had none", store.deadline)
	}
	if st := g.Status(context.Background()); st.WriteFailures != 0 || st.LastError != "" {
		t.Fatalf("status = %+v", st)
	}
	if err := g.Ready(context.Background()); err != nil || p.probes != 0 {
		t.Fatalf("store marked broken: %v probes %d", err, p.probes)
	}
}

// While its caller's context stands, the grace does not apply: a write that
// takes longer than it is not cut (the store's own limits end it, as before).
func TestGuardedWriteWhileItsCallerStaysTakesNoGrace(t *testing.T) {
	store := &ctxStore{hold: 200 * time.Millisecond}
	g := Guard(store, &fakePinger{}, true)
	g.writeGrace = 10 * time.Millisecond

	if _, err := g.Write(context.Background(), Record{Action: "helm.release.upgrade"}); err != nil {
		t.Fatalf("a write longer than the grace, its caller there: %v", err)
	}
	if len(store.rows) != 1 || store.hasDeadline {
		t.Fatalf("rows %d deadline %v (set %v), want one row and no deadline", len(store.rows), store.deadline, store.hasDeadline)
	}
	if st := g.Status(context.Background()); st.WriteFailures != 0 {
		t.Fatalf("status = %+v", st)
	}
}

// A caller that leaves while its write runs: the write ends writeGrace after the
// caller's context was cancelled, counted as a failure that names the grace.
func TestGuardedWriteEndsItsGraceAfterItsCallerLeft(t *testing.T) {
	store := &ctxStore{block: true, started: make(chan struct{})}
	g := Guard(store, &fakePinger{}, true)
	g.writeGrace = 50 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	left := make(chan time.Time, 1)
	go func() {
		<-store.started
		at := time.Now()
		cancel()
		left <- at
	}()

	_, err := g.Write(ctx, Record{Action: "helm.release.upgrade"})
	took := time.Since(<-left)
	if !errors.Is(err, errWriteGraceOver) || !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want the grace's end", err)
	}
	if took < 50*time.Millisecond || took > WriteGrace {
		t.Fatalf("write ended %v after the caller left, want about 50ms", took)
	}
	if st := g.Status(context.Background()); st.WriteFailures != 1 || !strings.Contains(st.LastError, "past its grace") {
		t.Fatalf("status = %+v", st)
	}
}

// A caller's deadline is the write's: one not reached stays as it is, one that
// comes before the grace ends ends the write (a step of a shutdown keeps its
// budget), and one already past ends it as before.
func TestGuardedWriteKeepsItsCallersDeadline(t *testing.T) {
	store := &ctxStore{}
	g := Guard(store, &fakePinger{}, true)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	want, _ := ctx.Deadline()
	if _, err := g.Write(ctx, Record{Action: "k8s.node.drain"}); err != nil {
		t.Fatal(err)
	}
	if !store.hasDeadline || !store.deadline.Equal(want) {
		t.Fatalf("write deadline = %v (set %v), want the caller's %v", store.deadline, store.hasDeadline, want)
	}

	blocked := &ctxStore{block: true}
	gb := Guard(blocked, &fakePinger{}, true)
	gb.writeGrace = 10 * time.Second
	early, cancelEarly := context.WithTimeout(context.Background(), 50*time.Millisecond)
	cancelEarly() // cancelled, its deadline still 50ms off and before the grace's end
	if _, err := gb.Write(early, Record{Action: "k8s.node.drain"}); !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errWriteGraceOver) {
		t.Fatalf("err = %v, want the caller's deadline", err)
	}

	past, cancelPast := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelPast()
	if _, err := g.Write(past, Record{Action: "k8s.node.drain"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the caller's deadline", err)
	}
	if len(store.rows) != 1 || g.Status(context.Background()).WriteFailures != 1 {
		t.Fatalf("rows %d failures %d", len(store.rows), g.Status(context.Background()).WriteFailures)
	}
}

// Guard sets WriteGrace, 5 s, and a Guarded made without Guard (write grace 0)
// writes as one made with it, also after its caller left.
func TestAGuardedMadeWithoutGuardTakesWriteGrace(t *testing.T) {
	if g := Guard(&fakeStore{}, nil, true); g.writeGrace != WriteGrace || WriteGrace != 5*time.Second {
		t.Fatalf("write grace = %v (WriteGrace %v), want 5s", g.writeGrace, WriteGrace)
	}
	store := &ctxStore{hold: 50 * time.Millisecond}
	g := &Guarded{Store: store}
	if _, err := g.Write(context.Background(), Record{Action: "k8s.pod.delete"}); err != nil {
		t.Fatalf("zero Guarded: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := g.Write(ctx, Record{Action: "k8s.pod.delete"}); err != nil {
		t.Fatalf("zero Guarded, its caller gone: %v", err)
	}
	if len(store.rows) != 2 || g.failures.Load() != 0 {
		t.Fatalf("rows %d failures %d", len(store.rows), g.failures.Load())
	}
}
