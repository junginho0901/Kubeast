package k8s

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"sync"
	"testing"
	"time"
)

// silentListener takes TCP connections and never says a word on them: a TLS handshake to it never ends.
func silentListener(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var held []net.Conn
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			held = append(held, c)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range held {
			_ = c.Close()
		}
	})
	return "https://" + ln.Addr().String()
}

// apiStandIn answers status, or with wait holds the request until the client goes, or with drop ends the connection
// without a response.
func apiStandIn(t *testing.T, status int, wait, drop bool) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case drop:
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
		case wait:
			select {
			case <-r.Context().Done():
			case <-time.After(10 * time.Second):
			}
		default:
			w.WriteHeader(status)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func closedAddress(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	return url
}

// callThrough sends one GET to url through answerNotice on a transport of its own, in ctx.
func callThrough(t *testing.T, ctx context.Context, url string) {
	t.Helper()
	tr := &http.Transport{}
	t.Cleanup(tr.CloseIdleConnections)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/api/v1/pods", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp, err := (answerNotice{base: tr}).RoundTrip(req); err == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
}

// A call that could not reach the cluster is a failure: refused, a connection dropped without a response, a deadline
// that passed while it was still connecting. A response of any status is none, nor is Kubeast giving up on a call the API
// server had: a deadline once the request was sent (a slow list), the caller leaving, a context over before the call.
func TestOnlyACallThatCouldNotReachTheClusterIsUnreached(t *testing.T) {
	deadline := func(d time.Duration) func(t *testing.T) context.Context {
		return func(t *testing.T) context.Context {
			ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(d))
			t.Cleanup(cancel)
			return ctx
		}
	}
	cancelledAfter := func(d time.Duration) func(t *testing.T) context.Context {
		return func(t *testing.T) context.Context {
			ctx, cancel := context.WithCancel(context.Background())
			time.AfterFunc(d, cancel)
			t.Cleanup(cancel)
			return ctx
		}
	}
	answering := func(status int) func(t *testing.T) string {
		return func(t *testing.T) string { return apiStandIn(t, status, false, false) }
	}
	for name, c := range map[string]struct {
		url       func(t *testing.T) string
		ctx       func(t *testing.T) context.Context
		unreached bool
		answered  bool
	}{
		"refused":                              {url: closedAddress, unreached: true},
		"dropped without a response":           {url: func(t *testing.T) string { return apiStandIn(t, 0, false, true) }, unreached: true},
		"a deadline while connecting":          {url: silentListener, ctx: deadline(200 * time.Millisecond), unreached: true},
		"an aggregated API answering 503":      {url: answering(http.StatusServiceUnavailable)},
		"the API server's 504":                 {url: answering(http.StatusGatewayTimeout)},
		"a 404":                                {url: answering(http.StatusNotFound), answered: true},
		"a deadline once the request was sent": {url: func(t *testing.T) string { return apiStandIn(t, 0, true, false) }, ctx: deadline(200 * time.Millisecond)},
		"the caller left while connecting":     {url: silentListener, ctx: cancelledAfter(200 * time.Millisecond)},
		"a context over before the call":       {url: closedAddress, ctx: deadline(-time.Second)},
	} {
		t.Run(name, func(t *testing.T) {
			base := context.Background()
			if c.ctx != nil {
				base = c.ctx(t)
			}
			answered := false
			ctx, calls := WithClusterCalls(base, func() { answered = true })
			callThrough(t, ctx, c.url(t))
			if calls.Unreached() != c.unreached || answered != c.answered {
				t.Errorf("unreached %v, answered %v; want %v, %v", calls.Unreached(), answered, c.unreached, c.answered)
			}
		})
	}
}

// A request is a failure only when none of its calls got a response: one that did, an API server's 503 too, says the
// cluster was reached, whatever another call met.
func TestARequestWithAResponseToOneCallIsNotUnreached(t *testing.T) {
	for name, status := range map[string]int{"a 404": http.StatusNotFound, "an aggregated API's 503": http.StatusServiceUnavailable} {
		t.Run(name, func(t *testing.T) {
			ctx, calls := WithClusterCalls(context.Background(), func() {})
			callThrough(t, ctx, closedAddress(t))
			if !calls.Unreached() {
				t.Fatal("a refused call alone is not unreached")
			}
			callThrough(t, ctx, apiStandIn(t, status, false, false))
			if calls.Unreached() {
				t.Error("a request one of whose calls got a response is unreached")
			}
		})
	}
}

// writeFails is a transport whose write of the request fails, then waits for the request's deadline.
type writeFails struct{}

func (writeFails) RoundTrip(req *http.Request) (*http.Response, error) {
	if trace := httptrace.ContextClientTrace(req.Context()); trace != nil && trace.WroteRequest != nil {
		trace.WroteRequest(httptrace.WroteRequestInfo{Err: errors.New("write: broken pipe")})
	}
	<-req.Context().Done()
	return nil, req.Context().Err()
}

// A deadline that passed while the request could not be written found no API server holding it: unreached.
func TestADeadlineAfterAFailedWriteIsUnreached(t *testing.T) {
	base, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	ctx, calls := WithClusterCalls(base, func() {})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://127.0.0.1:1/api/v1/pods", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (answerNotice{base: writeFails{}}).RoundTrip(req); err == nil {
		t.Fatal("the call was answered")
	}
	if !calls.Unreached() {
		t.Error("a deadline after a failed write is not unreached")
	}
}
