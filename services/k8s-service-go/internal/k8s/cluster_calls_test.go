package k8s

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
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

// callThrough sends one GET to url through the answerNotice of cluster c1 on a transport of its own, in ctx.
func callThrough(t *testing.T, ctx context.Context, url string) {
	t.Helper()
	callThroughCluster(t, ctx, "c1", url)
}

func callThroughCluster(t *testing.T, ctx context.Context, id cluster.ID, url string) {
	t.Helper()
	tr := &http.Transport{}
	t.Cleanup(tr.CloseIdleConnections)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/api/v1/pods", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp, err := (answerNotice{base: tr, id: id}).RoundTrip(req); err == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
}

// A call that could not reach the cluster is a failure: refused, a connection dropped without a response, a deadline
// that passed while it was still connecting. A response of any status is none, nor is Kubeast giving up on a call the API
// server had: a deadline once the request was sent (a slow list), the caller leaving, a context over before the call.
// A 5xx and a deadline once the request was sent are calls the cluster took and did not answer.
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
		url        func(t *testing.T) string
		ctx        func(t *testing.T) context.Context
		unreached  bool
		answered   bool
		unanswered bool
	}{
		"refused":                              {url: closedAddress, unreached: true},
		"dropped without a response":           {url: func(t *testing.T) string { return apiStandIn(t, 0, false, true) }, unreached: true},
		"a deadline while connecting":          {url: silentListener, ctx: deadline(200 * time.Millisecond), unreached: true},
		"an aggregated API answering 503":      {url: answering(http.StatusServiceUnavailable), unanswered: true},
		"the API server's 504":                 {url: answering(http.StatusGatewayTimeout), unanswered: true},
		"a 404":                                {url: answering(http.StatusNotFound), answered: true},
		"a deadline once the request was sent": {url: func(t *testing.T) string { return apiStandIn(t, 0, true, false) }, ctx: deadline(200 * time.Millisecond), unanswered: true},
		"the caller left while connecting":     {url: silentListener, ctx: cancelledAfter(200 * time.Millisecond)},
		"a context over before the call":       {url: closedAddress, ctx: deadline(-time.Second)},
	} {
		t.Run(name, func(t *testing.T) {
			base := context.Background()
			if c.ctx != nil {
				base = c.ctx(t)
			}
			answered := false
			ctx, calls := WithClusterCalls(base, "c1", func() { answered = true })
			callThrough(t, ctx, c.url(t))
			if calls.Unreached() != c.unreached || answered != c.answered || calls.Unanswered() != c.unanswered {
				t.Errorf("unreached %v, answered %v, unanswered %v; want %v, %v, %v",
					calls.Unreached(), answered, calls.Unanswered(), c.unreached, c.answered, c.unanswered)
			}
		})
	}
}

// A request is a failure only when none of its calls got a response: one that did, an API server's 503 too, says the
// cluster was reached, whatever another call met.
func TestARequestWithAResponseToOneCallIsNotUnreached(t *testing.T) {
	for name, status := range map[string]int{"a 404": http.StatusNotFound, "an aggregated API's 503": http.StatusServiceUnavailable} {
		t.Run(name, func(t *testing.T) {
			ctx, calls := WithClusterCalls(context.Background(), "c1", func() {})
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

// tries is a transport that plays the trace of its own tries, as net/http and x/net/http2 call it: each try gets a
// connection, and sends its headers where true; then the body waits until the deadline and fails with it.
type tries []bool

func (ts tries) RoundTrip(req *http.Request) (*http.Response, error) {
	trace := httptrace.ContextClientTrace(req.Context())
	if trace == nil {
		trace = &httptrace.ClientTrace{}
	}
	for _, headersSent := range ts {
		if trace.GetConn != nil {
			trace.GetConn(req.URL.Host)
		}
		if headersSent && trace.WroteHeaders != nil {
			trace.WroteHeaders()
		}
	}
	<-req.Context().Done()
	if trace.WroteRequest != nil {
		trace.WroteRequest(httptrace.WroteRequestInfo{Err: req.Context().Err()})
	}
	return nil, req.Context().Err()
}

// A deadline counts by the last try's headers: sent, the API server holds the request though its body waited (HTTP/2
// flow control); not sent, the call did not reach it, also after an earlier try of the transport's own had sent them.
func TestADeadlineCountsByWhetherTheLastTrySentItsHeaders(t *testing.T) {
	for name, c := range map[string]struct {
		tries      tries
		unreached  bool
		unanswered bool
	}{
		"headers sent, the body held back":              {tries{true}, false, true},
		"headers never sent":                            {tries{false}, true, false},
		"a second try still connecting at the deadline": {tries{true, false}, true, false},
	} {
		t.Run(name, func(t *testing.T) {
			base, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			ctx, calls := WithClusterCalls(base, "c1", func() {})
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://127.0.0.1:1/api/v1/namespaces/a/configmaps", nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := (answerNotice{base: c.tries, id: "c1"}).RoundTrip(req); err == nil {
				t.Fatal("the call was answered")
			}
			if calls.Unreached() != c.unreached || calls.Unanswered() != c.unanswered {
				t.Errorf("unreached %v, unanswered %v; want %v, %v", calls.Unreached(), calls.Unanswered(), c.unreached, c.unanswered)
			}
		})
	}
}

// A record is of one cluster: a call to another (a live list socket's subscription to a second cluster) neither fails
// it nor answers it.
func TestACallToAnotherClusterIsNotRecorded(t *testing.T) {
	for name, url := range map[string]func(t *testing.T) string{
		"refused": closedAddress,
		"a 200":   func(t *testing.T) string { return apiStandIn(t, http.StatusOK, false, false) },
	} {
		t.Run(name, func(t *testing.T) {
			answered := false
			ctx, calls := WithClusterCalls(context.Background(), "c1", func() { answered = true })
			callThroughCluster(t, ctx, "c2", url(t))
			if calls.Unreached() || calls.Unanswered() || answered {
				t.Errorf("a call to c2 went into c1's record: unreached %v, unanswered %v, answered %v", calls.Unreached(), calls.Unanswered(), answered)
			}
		})
	}
}
