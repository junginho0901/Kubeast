package k8s

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// shortReadWait makes clusterReadWait d until the test ends.
func shortReadWait(t *testing.T, d time.Duration) {
	t.Helper()
	was := clusterReadWait
	clusterReadWait = d
	t.Cleanup(func() { clusterReadWait = was })
}

// The reads readWait times are those the API server answers and ends; a watch, a followed log, an upgrade and the proxy
// subresource, which it keeps open or passes on, and a write are not, also under a server URL's path.
func TestReadWaitTimesTheReadsOnly(t *testing.T) {
	for _, serverPath := range []string{"", "/k8s/clusters/c-1"} {
		for _, c := range []struct {
			method, path string
			upgrade      bool
			timed        bool
		}{
			{"GET", "/api/v1/namespaces", false, true},
			{"GET", "/api/v1/namespaces/a/pods?limit=500", false, true},
			{"HEAD", "/api/v1/namespaces/a", false, true},
			{"GET", "/apis/apps/v1/namespaces/a/deployments/d", false, true},
			{"GET", "/version", false, true},
			{"GET", "/apis", false, true},
			{"GET", "/api/v1/namespaces/a/pods/p/log?container=c&tailLines=100", false, true},
			{"POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", false, true},
			{"POST", "/apis/authorization.k8s.io/v1/namespaces/a/localsubjectaccessreviews", false, true},
			{"POST", "/apis/authentication.k8s.io/v1/selfsubjectreviews", false, true},
			{"GET", "/api/v1/namespaces/a/pods?watch=true", false, false},
			{"GET", "/apis/apps/v1/deployments?watch=1&resourceVersion=5", false, false},
			{"GET", "/api/v1/watch/namespaces/a/pods", false, false},
			{"GET", "/api/v1/namespaces/a/pods/p/log?follow=true", false, false},
			{"POST", "/api/v1/namespaces/a/pods/p/exec?command=sh", true, false},
			{"GET", "/api/v1/namespaces/a/pods/p/exec?command=sh", true, false},
			{"GET", "/api/v1/namespaces/a/pods/p/attach", false, false},
			{"POST", "/api/v1/namespaces/a/pods/p/portforward", false, false},
			{"GET", "/api/v1/namespaces/monitoring/services/http:prometheus:9090/proxy/api/v1/query", false, false},
			{"GET", "/api/v1/nodes/n1/proxy/stats/summary", false, false},
			{"GET", "/api/v1/proxy/namespaces/a/services/s", false, false},
			{"POST", "/api/v1/namespaces/a/configmaps", false, false},
			{"PUT", "/api/v1/namespaces/a/configmaps/c", false, false},
			{"PATCH", "/apis/apps/v1/namespaces/a/deployments/d", false, false},
			{"DELETE", "/api/v1/namespaces/a/pods/p", false, false},
			{"POST", "/api/v1/namespaces/a/pods/p/eviction", false, false},
		} {
			req := httptest.NewRequest(c.method, "https://api.example"+serverPath+c.path, nil)
			if c.upgrade {
				req.Header.Set("Connection", "Upgrade")
				req.Header.Set("Upgrade", "SPDY/3.1")
			}
			if got := waitsFor(req, serverPath); got != c.timed {
				t.Errorf("%s %s%s: timed %v, want %v", c.method, serverPath, c.path, got, c.timed)
			}
		}
	}
	// a proxy path read under another server path is outside the API: timed as a read
	if !waitsFor(httptest.NewRequest("GET", "https://api.example/other/api/v1/nodes/n1/proxy/x", nil), "/k8s/clusters/c-1") {
		t.Error("a GET outside the server path was not timed")
	}
}

// standIn answers after holding each request hold (headers and all), or with slowBody sends its headers at once and its
// body over slowBody; hits counts the requests it got.
func standIn(t *testing.T, hold, slowBody time.Duration) (string, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		select {
		case <-r.Context().Done():
			return
		case <-time.After(hold):
		}
		w.WriteHeader(http.StatusOK)
		if slowBody > 0 {
			w.(http.Flusher).Flush()
			for i := 0; i < 5; i++ {
				_, _ = fmt.Fprint(w, "part ")
				w.(http.Flusher).Flush()
				time.Sleep(slowBody / 5)
			}
		}
		_, _ = fmt.Fprint(w, "end")
	}))
	t.Cleanup(srv.Close)
	return srv.URL, &hits
}

func send(t *testing.T, ctx context.Context, rt http.RoundTripper, method, url string) (string, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := rt.RoundTrip(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}

// A read whose API server does not start its answer within the wait ends with ErrClusterNoAnswer, a deadline; one whose
// answer starts in time is read to its end however long its body takes; a watch and a write wait for their answer.
func TestAReadWaitsForTheStartOfItsAnswerOnly(t *testing.T) {
	shortReadWait(t, 200*time.Millisecond)
	tr := &http.Transport{}
	t.Cleanup(tr.CloseIdleConnections)
	rt := newReadWait(tr, "c1", "")

	silent, _ := standIn(t, 10*time.Second, 0)
	start := time.Now()
	_, err := send(t, context.Background(), rt, http.MethodGet, silent+"/api/v1/namespaces")
	if !errors.Is(err, ErrClusterNoAnswer) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a read of a silent API server: %v", err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("the read ended after %s, past its wait", took)
	}
	if !strings.Contains(err.Error(), "context deadline exceeded") {
		t.Errorf("handleError answers 503 by the words context deadline exceeded: %q", err)
	}

	slow, _ := standIn(t, 0, time.Second)
	if body, err := send(t, context.Background(), rt, http.MethodGet, slow+"/api/v1/namespaces"); err != nil || body != "part part part part part end" {
		t.Errorf("an answer that started in time was cut: %q %v", body, err)
	}

	late, _ := standIn(t, 600*time.Millisecond, 0)
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/namespaces/a/pods?watch=true"},
		{http.MethodGet, "/api/v1/namespaces/a/pods/p/log?follow=true"},
		{http.MethodPost, "/api/v1/namespaces/a/configmaps"},
		{http.MethodDelete, "/api/v1/namespaces/a/pods/p"},
	} {
		if body, err := send(t, context.Background(), rt, c.method, late+c.path); err != nil || body != "end" {
			t.Errorf("%s %s did not wait for its answer: %q %v", c.method, c.path, body, err)
		}
	}
}

// A read readWait stopped waiting for counts as a deadline does: unanswered once its headers went out (the breaker
// leaves it to the health sweep), unreached while it was still connecting; a caller leaving is still neither.
func TestAReadThatRanOutItsWaitCountsAsADeadline(t *testing.T) {
	shortReadWait(t, 200*time.Millisecond)
	silent, _ := standIn(t, 10*time.Second, 0)
	for name, c := range map[string]struct {
		url        func(t *testing.T) string
		unreached  bool
		unanswered bool
	}{
		"sent, never answered":            {url: func(*testing.T) string { return silent }, unanswered: true},
		"a TLS handshake that never ends": {url: silentListener, unreached: true},
	} {
		t.Run(name, func(t *testing.T) {
			tr := &http.Transport{}
			t.Cleanup(tr.CloseIdleConnections)
			rt := newReadWait(answerNotice{base: tr, id: "c1"}, "c1", "")
			ctx, calls := WithClusterCalls(context.Background(), "c1", func() {})
			if _, err := send(t, ctx, rt, http.MethodGet, c.url(t)+"/api/v1/namespaces"); !errors.Is(err, ErrClusterNoAnswer) {
				t.Fatalf("not ended by the wait: %v", err)
			}
			if calls.Unreached() != c.unreached || calls.Unanswered() != c.unanswered {
				t.Errorf("unreached %v, unanswered %v; want %v, %v", calls.Unreached(), calls.Unanswered(), c.unreached, c.unanswered)
			}
		})
	}
	t.Run("the caller left first", func(t *testing.T) {
		tr := &http.Transport{}
		t.Cleanup(tr.CloseIdleConnections)
		rt := newReadWait(answerNotice{base: tr, id: "c1"}, "c1", "")
		base, cancel := context.WithCancel(context.Background())
		time.AfterFunc(50*time.Millisecond, cancel)
		ctx, calls := WithClusterCalls(base, "c1", func() {})
		if _, err := send(t, ctx, rt, http.MethodGet, silentListener(t)+"/api/v1/namespaces"); err == nil || errors.Is(err, ErrClusterNoAnswer) {
			t.Fatalf("a caller leaving read as the wait running out: %v", err)
		}
		if calls.Unreached() || calls.Unanswered() {
			t.Errorf("a caller leaving while connecting counted: unreached %v, unanswered %v", calls.Unreached(), calls.Unanswered())
		}
	})
}

// Once one of a request's reads ran out its wait, the request sends that cluster no other read: an access check that
// went unanswered is not followed by the person's check and a list as the person, each waiting again. Its writes still
// go, and another request, or a read of another cluster, is not held to it.
func TestARequestSendsNoOtherReadOnceOneRanOutItsWait(t *testing.T) {
	shortReadWait(t, 200*time.Millisecond)
	tr := &http.Transport{}
	t.Cleanup(tr.CloseIdleConnections)
	silent, hits := standIn(t, 10*time.Second, 0)
	c1 := newReadWait(answerNotice{base: tr, id: "c1"}, "c1", "")
	c2 := newReadWait(answerNotice{base: tr, id: "c2"}, "c2", "")

	ctx, calls := WithClusterCalls(context.Background(), "c1", func() {})
	if _, err := send(t, ctx, c1, http.MethodPost, silent+"/apis/authorization.k8s.io/v1/selfsubjectaccessreviews"); !errors.Is(err, ErrClusterNoAnswer) {
		t.Fatalf("the first read: %v", err)
	}
	if hits.Load() != 1 {
		t.Fatalf("the stand-in got %d requests, want 1", hits.Load())
	}
	start := time.Now()
	for _, p := range []string{"/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", "/api/v1/namespaces"} {
		method := http.MethodGet
		if strings.Contains(p, "reviews") {
			method = http.MethodPost
		}
		if _, err := send(t, ctx, c1, method, silent+p); !errors.Is(err, ErrClusterNoAnswer) {
			t.Errorf("%s after a read ran out its wait: %v", p, err)
		}
	}
	if took := time.Since(start); took > 100*time.Millisecond {
		t.Errorf("the reads not sent took %s", took)
	}
	if hits.Load() != 1 {
		t.Errorf("the request's other reads were sent: %d requests", hits.Load())
	}
	if !calls.Unanswered() || calls.Unreached() {
		t.Errorf("the request reads unreached %v, unanswered %v; want false, true", calls.Unreached(), calls.Unanswered())
	}

	answering, answered := standIn(t, 0, 0)
	if body, err := send(t, ctx, c1, http.MethodPost, answering+"/api/v1/namespaces/a/configmaps"); err != nil || body != "end" {
		t.Errorf("the request's write was held: %q %v", body, err)
	}
	if body, err := send(t, ctx, c2, http.MethodGet, answering+"/api/v1/namespaces"); err != nil || body != "end" {
		t.Errorf("the request's read of another cluster was held: %q %v", body, err)
	}
	other, _ := WithClusterCalls(context.Background(), "c1", func() {})
	if body, err := send(t, other, c1, http.MethodGet, answering+"/api/v1/namespaces"); err != nil || body != "end" {
		t.Errorf("another request's read was held: %q %v", body, err)
	}
	if answered.Load() != 3 {
		t.Errorf("the answering stand-in got %d requests, want 3", answered.Load())
	}
}

// A request that waited on another's access check the cluster did not answer in time sends no read of its own after it,
// as the one whose call it was.
func TestARequestThatWaitedOnAnUnansweredCheckSendsNoRead(t *testing.T) {
	s := &Service{}
	b := &clientBundle{id: "c1"}
	release := make(chan struct{})
	var runs atomic.Int64
	ask := func(context.Context) (bool, error) {
		if runs.Add(1) == 1 {
			<-release
		}
		return false, noAnswer()
	}
	first, firstCalls := WithClusterCalls(context.Background(), "c1", func() {})
	firstDone := make(chan error, 1)
	go func() {
		_, err := s.askOnce(first, b, "c1|q|u", ask)
		firstDone <- err
	}()
	if !eventually(t, 2*time.Second, func() bool { return runs.Load() == 1 }) {
		t.Fatal("the first question never ran")
	}
	joiner, joinerCalls := WithClusterCalls(context.Background(), "c1", func() {})
	other, otherCalls := WithClusterCalls(context.Background(), "c2", func() {})
	joined := make(chan error, 2)
	go func() { _, err := s.askOnce(joiner, b, "c1|q|u", ask); joined <- err }()
	go func() { _, err := s.askOnce(other, b, "c1|q|u", ask); joined <- err }()
	time.Sleep(100 * time.Millisecond) // both wait on the first question
	close(release)
	if err := <-firstDone; !errors.Is(err, ErrClusterNoAnswer) {
		t.Fatalf("the first question: %v", err)
	}
	for i := 0; i < 2; i++ {
		if err := <-joined; !errors.Is(err, ErrClusterNoAnswer) {
			t.Fatalf("a joined question: %v", err)
		}
	}
	if !joinerCalls.waitedOut.Load() || !firstCalls.waitedOut.Load() {
		t.Errorf("a request of the unanswered check would send its own reads: waiter %v, asker %v", joinerCalls.waitedOut.Load(), firstCalls.waitedOut.Load())
	}
	if otherCalls.waitedOut.Load() {
		t.Error("a record of another cluster was marked")
	}
	// a check that was answered, or refused for another reason, marks no one
	s2 := &Service{}
	ctx, calls := WithClusterCalls(context.Background(), "c1", func() {})
	_, _ = s2.askOnce(ctx, b, "c1|q2|u", func(context.Context) (bool, error) { return false, errors.New("forbidden") })
	_, _ = s2.askOnce(ctx, b, "c1|q3|u", func(context.Context) (bool, error) { return true, nil })
	if calls.waitedOut.Load() {
		t.Error("a check with another error, or an answer, marked the request")
	}
}

// Through a bundle as buildClientBundle makes it: a list of a silent API server ends with the wait, kubeast:cache's
// too; a watch is left to its caller's time.
func TestABundlesReadsOfASilentAPIServerEndWithTheWait(t *testing.T) {
	shortReadWait(t, 200*time.Millisecond)
	silent, _ := standIn(t, 10*time.Second, 0)
	kubeconfig := strings.Replace(testKubeconfig, "https://127.0.0.1:6443", silent+"/k8s/clusters/c-1", 1)
	b, err := buildClientBundle(cluster.Info{ID: "c1", Mode: cluster.ModeExternal, KubeconfigBlob: kubeconfig})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })
	for name, list := range map[string]func(ctx context.Context) error{
		"as the person": func(ctx context.Context) error {
			_, err := b.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
			return err
		},
		"as kubeast:cache": func(ctx context.Context) error {
			_, err := b.cacheClient.CoreV1().Pods("").List(ctx, metav1.ListOptions{FieldSelector: "spec.nodeName=n1"})
			return err
		},
	} {
		start := time.Now()
		if err := list(context.Background()); !errors.Is(err, ErrClusterNoAnswer) {
			t.Errorf("%s: %v", name, err)
		}
		if took := time.Since(start); took > 3*time.Second {
			t.Errorf("%s ended after %s", name, took)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := b.clientset.CoreV1().Pods("a").Watch(ctx, metav1.ListOptions{}); err == nil || errors.Is(err, ErrClusterNoAnswer) {
		t.Errorf("a watch was ended by the read wait: %v", err)
	}
	if took := time.Since(start); took < 700*time.Millisecond {
		t.Errorf("the watch ended after %s, before its caller's time", took)
	}
}
