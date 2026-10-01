package audit

import (
	"context"
	"errors"
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
