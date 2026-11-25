package k8s

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// clusterReadWait is how long a read call to a cluster waits for the API server to start its answer: its response
// headers, not its body. It is past the 15 s kube-apiserver keeps a request in its flow control queue before it answers
// 429 itself (RequestTimeout/4), inside the 30 s ai-service gives a call to k8s-service, and two such waits end 20 s
// inside the gateway's 60 s (nginx's default proxy_read_timeout, which the k8s-service locations keep). Without it a
// request on a connection to an API server that went silent waited for client-go's HTTP/2 check (30 + 15 s), a retry
// and its TLS handshake (10 s): about 55 s.
var clusterReadWait = 20 * time.Second

// ErrClusterNoAnswer is a read call whose API server did not start to answer within clusterReadWait.
var ErrClusterNoAnswer = errors.New("the cluster's API server did not answer")

// errReadWaitOver is the cause readWait ends a call's context with; answerNotice reads it as a deadline.
var errReadWaitOver = errors.New("cluster read wait over")

// noAnswer is the error of a read readWait stopped waiting for, or did not send: a deadline, which handleError answers
// 503 as it does a cluster that cannot be reached.
func noAnswer() error {
	return fmt.Errorf("%w within %s: %w", ErrClusterNoAnswer, clusterReadWait, context.DeadlineExceeded)
}

// readWait stops waiting for a read call's answer after clusterReadWait (waitsFor says which calls). It sits outside
// answerNotice, so a call the API server had counts as unanswered and one that had not gone out as unreached, as a
// deadline does. Once one of a request's reads of the cluster ran out its wait (ClusterCalls), the request sends that
// cluster no other read: it would wait on the same silent API server.
type readWait struct {
	base       http.RoundTripper
	id         cluster.ID
	serverPath string // the path of the cluster's server URL, cleaned; "" for none
}

func newReadWait(base http.RoundTripper, id cluster.ID, serverPath string) http.RoundTripper {
	serverPath = path.Clean("/" + serverPath)
	if serverPath == "/" {
		serverPath = ""
	}
	return readWait{base: base, id: id, serverPath: serverPath}
}

func (t readWait) RoundTrip(req *http.Request) (*http.Response, error) {
	if !waitsFor(req, t.serverPath) {
		return t.base.RoundTrip(req)
	}
	calls, ok := req.Context().Value(clusterCallsKey{}).(*ClusterCalls)
	if !ok || calls.id != t.id {
		calls = nil
	}
	if calls != nil && calls.waitedOut.Load() {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, noAnswer()
	}
	ctx, cancel := context.WithCancelCause(req.Context())
	timer := time.AfterFunc(clusterReadWait, func() { cancel(errReadWaitOver) })
	resp, err := t.base.RoundTrip(req.WithContext(ctx))
	if timer.Stop() {
		if err != nil || resp == nil || resp.Body == nil {
			cancel(nil)
			return resp, err
		}
		// the answer started in time: its body is read as long as it takes
		resp.Body = &cancelOnClose{ReadCloser: resp.Body, cancel: cancel}
		return resp, nil
	}
	// the wait ran out; an answer that came at that moment goes too, as its body ends with the context
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if calls != nil {
		calls.waitedOut.Store(true)
	}
	return nil, noAnswer()
}

// cancelOnClose ends a call's context once its body is closed.
type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelCauseFunc
}

func (b *cancelOnClose) Close() error {
	err := b.ReadCloser.Close()
	b.cancel(nil)
	return err
}

// waitsFor says whether readWait times req: a GET or HEAD, or the POST of a review (authorization.k8s.io,
// authentication.k8s.io), which writes nothing. Not a request the API server keeps open or passes on: a watch, a
// followed log, an upgrade (exec, attach, port-forward) and the proxy subresource, the API server's own long-running
// requests less a log that is not followed. A write is not timed: one cut while the API server works on it may still
// be applied.
func waitsFor(req *http.Request, serverPath string) bool {
	if req.Header.Get("Upgrade") != "" {
		return false
	}
	q := req.URL.Query()
	if queryTrue(q.Get("watch")) || queryTrue(q.Get("follow")) {
		return false
	}
	group, rest := apiPath(req.URL.Path, serverPath)
	if len(rest) > 0 && (rest[0] == "watch" || rest[0] == "proxy") {
		return false
	}
	if len(rest) > 2 && rest[0] == "namespaces" {
		rest = rest[2:]
	}
	if len(rest) > 2 {
		switch rest[2] {
		case "proxy", "exec", "attach", "portforward":
			return false
		}
	}
	switch req.Method {
	case http.MethodGet, http.MethodHead:
		return true
	case http.MethodPost:
		return group == "authorization.k8s.io" || group == "authentication.k8s.io"
	}
	return false
}

// apiPath is the API group of an API path under serverPath ("" for the core group) and the segments after its version;
// none for a path outside /api and /apis (/version, /healthz).
func apiPath(p, serverPath string) (group string, rest []string) {
	p, ok := strings.CutPrefix(p, serverPath)
	if !ok {
		return "", nil
	}
	seg := strings.Split(strings.Trim(p, "/"), "/")
	switch {
	case len(seg) >= 2 && seg[0] == "api":
		return "", seg[2:]
	case len(seg) >= 3 && seg[0] == "apis":
		return seg[1], seg[3:]
	}
	return "", nil
}

func queryTrue(s string) bool {
	b, err := strconv.ParseBool(s)
	return err == nil && b
}

// readsHeld says ctx's request sends cluster id no other read, as one of its reads ran out its wait.
func readsHeld(ctx context.Context, id cluster.ID) bool {
	calls, ok := ctx.Value(clusterCallsKey{}).(*ClusterCalls)
	return ok && calls.id == id && calls.waitedOut.Load()
}

// noteNoAnswer marks ctx's request when err is a read of cluster id that ran out its wait, also one it waited on for
// another request (an access check asked at the same moment), so its own reads of that cluster are not sent either.
func noteNoAnswer(ctx context.Context, id cluster.ID, err error) {
	if !errors.Is(err, ErrClusterNoAnswer) {
		return
	}
	if calls, ok := ctx.Value(clusterCallsKey{}).(*ClusterCalls); ok && calls.id == id {
		calls.waitedOut.Store(true)
	}
}
