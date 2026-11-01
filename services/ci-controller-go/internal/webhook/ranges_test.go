package webhook

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeMeta serves GitHub's /meta answer of 2026-11-01 (testdata) with an
// ETag, answering 304 to a matching If-None-Match, like api.github.com.
type fakeMeta struct {
	mu       sync.Mutex
	body     []byte
	etag     string
	status   int // when set, answered instead
	pollSecs string
	calls    atomic.Int32
	auth     atomic.Value
	cond     atomic.Int32 // requests that carried If-None-Match
}

func (f *fakeMeta) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.calls.Add(1)
	f.auth.Store(r.Header.Get("Authorization"))
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pollSecs != "" {
		w.Header().Set("X-Poll-Interval", f.pollSecs)
	}
	if f.status != 0 {
		w.WriteHeader(f.status)
		return
	}
	if inm := r.Header.Get("If-None-Match"); inm != "" {
		f.cond.Add(1)
		if inm == f.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	w.Header().Set("ETag", f.etag)
	w.Write(f.body)
}

func newMeta(t *testing.T) (*fakeMeta, *Ranges) {
	t.Helper()
	f := &fakeMeta{body: payload(t, "github-meta-20261101.json"), etag: `"v1"`}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, &Ranges{URL: srv.URL, HTTP: srv.Client()}
}

var (
	inHooks  = netip.MustParseAddr("9.234.106.49") // 9.234.106.48/28
	inHooks6 = netip.MustParseAddr("2a0a:a440::1") // 2a0a:a440::/29
	outside  = netip.MustParseAddr("203.0.113.9")
)

func TestRangesRefresh(t *testing.T) {
	f, r := newMeta(t)
	ctx := context.Background()
	if r.Loaded() || r.Contains(inHooks) {
		t.Fatal("a list before the first read")
	}
	changed, err := r.Refresh(ctx)
	if err != nil || !changed || !r.Loaded() {
		t.Fatalf("first read: %v %v", changed, err)
	}
	for addr, want := range map[netip.Addr]bool{inHooks: true, inHooks6: true, netip.AddrFrom16(inHooks.As16()): true, outside: false} {
		if r.Contains(addr) != want {
			t.Errorf("Contains(%s) = %v", addr, !want)
		}
	}
	// Unchanged: a conditional request answered 304.
	if changed, err := r.Refresh(ctx); err != nil || changed || f.cond.Load() != 1 || !r.Contains(inHooks) {
		t.Fatalf("second read: %v %v (conditional requests %d)", changed, err, f.cond.Load())
	}
	// GitHub moves its addresses.
	f.mu.Lock()
	f.body, f.etag = []byte(`{"hooks":["192.30.252.0/22","2620:112:3000::/44"]}`), `"v2"`
	f.mu.Unlock()
	if changed, err := r.Refresh(ctx); err != nil || !changed || r.Contains(inHooks) || !r.Contains(netip.MustParseAddr("192.30.252.77")) {
		t.Fatalf("moved list: %v %v", changed, err)
	}
	// The same list under a new ETag is not a change.
	f.mu.Lock()
	f.etag = `"v3"`
	f.mu.Unlock()
	if changed, err := r.Refresh(ctx); err != nil || changed {
		t.Fatalf("same list, new ETag: %v %v", changed, err)
	}
}

func TestRangesKeepTheLastGoodList(t *testing.T) {
	f, r := newMeta(t)
	ctx := context.Background()
	if _, err := r.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	for name, set := range map[string]func(){
		"server error": func() { f.status = 500 },
		"malformed":    func() { f.status, f.body, f.etag = 0, []byte(`{"hooks":["not a range"]}`), `"bad"` },
		"empty":        func() { f.status, f.body, f.etag = 0, []byte(`{"hooks":[]}`), `"empty"` },
		"not JSON":     func() { f.status, f.body, f.etag = 0, []byte(`<html>`), `"html"` },
	} {
		f.mu.Lock()
		set()
		f.mu.Unlock()
		if _, err := r.Refresh(ctx); err == nil {
			t.Errorf("%s: no error", name)
		}
		if !r.Contains(inHooks) {
			t.Fatalf("%s: the last good list was dropped", name)
		}
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := r.Refresh(cctx); err == nil || !r.Contains(inHooks) {
		t.Errorf("cancelled: %v", err)
	}
}

func TestRangesToken(t *testing.T) {
	f, r := newMeta(t)
	r.Token = func(context.Context) (string, error) { return "ghs_test", nil }
	if _, err := r.Refresh(context.Background()); err != nil || f.auth.Load() != "Bearer ghs_test" {
		t.Fatalf("authorization %q %v", f.auth.Load(), err)
	}
	r.Token = func(context.Context) (string, error) { return "", errors.New("no token") }
	before := f.calls.Load()
	if _, err := r.Refresh(context.Background()); err == nil || f.calls.Load() != before {
		t.Errorf("a token error still sent a request: %v", err)
	}
}

func TestRangesRun(t *testing.T) {
	f, r := newMeta(t)
	f.pollSecs = "120"
	r.Interval = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	results := make(chan error, 4)
	done := make(chan struct{})
	go func() {
		r.Run(ctx, func(_ bool, err error) { results <- err })
		close(done)
	}()
	if err := <-results; err != nil {
		t.Fatal(err)
	}
	// GitHub asked for 120 s between polls: no second read in a moment.
	time.Sleep(50 * time.Millisecond)
	if n := f.calls.Load(); n != 1 {
		t.Errorf("%d reads within 50 ms though x-poll-interval is 120 s", n)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop with its context")
	}
}

func TestHandlerUsesRanges(t *testing.T) {
	f, r := newMeta(t)
	fx := newFixture(t)
	fx.h.Ranges = r
	fx.h.AllowedSources = []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0")} // ignored once Ranges is set
	push := payload(t, "push_with-new-branch.payload.json")
	from := func(addr string) func(*http.Request) { return func(q *http.Request) { q.RemoteAddr = addr + ":443" } }
	if w := fx.send("POST", "push", "d-1", push, from(inHooks.String())); w.Code != 403 {
		t.Fatalf("before the list is read: %d", w.Code)
	}
	if _, err := r.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w := fx.send("POST", "push", "d-2", push, from(inHooks.String())); w.Code != 202 {
		t.Fatalf("from GitHub's range: %d %s", w.Code, w.Body.String())
	}
	if w := fx.send("POST", "push", "d-3", push, from(outside.String())); w.Code != 403 {
		t.Fatalf("from outside: %d", w.Code)
	}
	_ = f
}

// TestRangesConcurrent reads while refreshing; run with -race.
func TestRangesConcurrent(t *testing.T) {
	f, r := newMeta(t)
	if _, err := r.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 200 {
				r.Contains(inHooks)
			}
		}()
		if i == 0 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := range 20 {
					f.mu.Lock()
					f.etag = `"` + string(rune('a'+j)) + `"`
					f.mu.Unlock()
					r.Refresh(context.Background())
				}
			}()
		}
	}
	wg.Wait()
	if !r.Contains(inHooks) {
		t.Fatal("list lost")
	}
}
