package handler

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/streamcap"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/probe"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// asAccount is withLogFileContext for the account the test names in ?as= (u1 when none).
func asAccount(r *http.Request, namespace string, perms ...string) *http.Request {
	r = withLogFileContext(r, namespace, perms...)
	if as := r.URL.Query().Get("as"); as != "" {
		payload, _ := auth.FromContext(r.Context())
		payload.UserID = as
		r = r.WithContext(auth.WithPayload(r.Context(), payload))
	}
	return r
}

// streamServer serves one stream handler and waits, on cleanup, for every connection it took to be let go.
func streamServer(t *testing.T, serve http.HandlerFunc) *httptest.Server {
	t.Helper()
	var served sync.WaitGroup
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served.Add(1)
		defer served.Done()
		serve(w, r)
	}))
	t.Cleanup(func() { srv.CloseClientConnections(); served.Wait(); srv.Close() })
	return srv
}

func dialTerminal(t *testing.T, srv *httptest.Server, query string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"?"+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// wantCapClose reads the socket's next frame as the close a terminal refused at its account's cap gets.
func wantCapClose(t *testing.T, c *websocket.Conn) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := c.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != streamcap.CloseCode || closed.Text != streamcap.TerminalReason {
		t.Fatalf("got frame %q, err %v; want close %d %q", data, err, streamcap.CloseCode, streamcap.TerminalReason)
	}
}

func waitOpen(t *testing.T, caps *streamcap.Caps, account string, kind streamcap.Kind, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for caps.Open(account, kind) != want {
		if time.Now().After(deadline) {
			t.Fatalf("%s holds %d, want %d", account, caps.Open(account, kind), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// failedRows are the rows of action that say it failed, with what they say.
func (a *lockedAudit) failedRows(action string) []audit.Record {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []audit.Record
	for _, r := range a.rows {
		if r.Action == action && r.Result == audit.ResultFailure {
			out = append(out, r)
		}
	}
	return out
}

func execCapsHandler(t *testing.T, terminals int) (*Handler, *lockedAudit, *httptest.Server) {
	t.Helper()
	var version atomic.Int32
	h, store := liveHandler(t, func(http.ResponseWriter, *http.Request) {}, &version)
	h.streamCaps = streamcap.New(terminals, 0)
	fake := &fakeExecutor{endOnEOT: true}
	orig := newShellExecutor
	newShellExecutor = func(*rest.Config, *url.URL) (remotecommand.Executor, error) { return fake, nil }
	t.Cleanup(func() { newShellExecutor = orig })
	srv := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodExecWS(w, asAccount(r, "apps", "resource.pod.exec"))
	})
	return h, store, srv
}

func openShell(t *testing.T, srv *httptest.Server, as string) *websocket.Conn {
	t.Helper()
	c := dialTerminal(t, srv, "container=app&as="+as)
	readFrame(t, c) // ready
	readFrame(t, c) // prompt
	return c
}

// One account past its cap gets no shell, with the close the screen reads and a failed row; another account is counted
// apart; a terminal that ends — its shell exits, or its browser goes — gives its place back.
func TestAnExecTerminalPastItsAccountsCapIsRefusedAndAPlaceComesBackWhenOneEnds(t *testing.T) {
	h, store, srv := execCapsHandler(t, 2)
	first := openShell(t, srv, "u1")
	second := openShell(t, srv, "u1")
	waitOpen(t, h.streamCaps, "u1", streamcap.Terminal, 2)

	wantCapClose(t, dialTerminal(t, srv, "container=app&as=u1"))
	rows := store.failedRows("k8s.pod.exec")
	if len(rows) != 1 || !strings.Contains(rows[0].Error, "terminals: this account has 2 open on this server") || rows[0].ActorUserID != "u1" {
		t.Fatalf("failed rows = %+v, want one saying the cap", rows)
	}
	if got := h.streamCaps.Open("u1", streamcap.Terminal); got != 2 {
		t.Fatalf("u1 holds %d after the refusal, want 2", got)
	}

	openShell(t, srv, "u2") // another account is counted apart

	// The first shell exits on its own.
	if err := first.WriteMessage(websocket.TextMessage, []byte{0x04}); err != nil {
		t.Fatal(err)
	}
	waitOpen(t, h.streamCaps, "u1", streamcap.Terminal, 1)
	// The second one's browser goes without a close.
	_ = second.UnderlyingConn().Close()
	waitOpen(t, h.streamCaps, "u1", streamcap.Terminal, 0)

	openShell(t, srv, "u1")
	if rows := store.failedRows("k8s.pod.exec"); len(rows) != 1 {
		t.Fatalf("failed rows = %d after the places came back, want still 1", len(rows))
	}
}

// A terminal the server's leaving closed gives its place back too.
func TestAnExecTerminalTheServerLeavingClosedGivesItsPlaceBack(t *testing.T) {
	h, _, srv := execCapsHandler(t, 1)
	p := probe.New()
	h.SetLeaving(p)
	c := openShell(t, srv, "u1")
	waitOpen(t, h.streamCaps, "u1", streamcap.Terminal, 1)
	p.Leave()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			break
		}
	}
	waitOpen(t, h.streamCaps, "u1", streamcap.Terminal, 0)
}

func TestNoTerminalCapWithZero(t *testing.T) {
	h, store, srv := execCapsHandler(t, 0)
	for i := 0; i < 5; i++ {
		openShell(t, srv, "u1")
	}
	waitOpen(t, h.streamCaps, "u1", streamcap.Terminal, 5)
	if rows := store.failedRows("k8s.pod.exec"); len(rows) != 0 {
		t.Fatalf("failed rows = %+v with no cap", rows)
	}
}

// A node shell past its account's cap makes no debug pod.
func TestANodeShellPastItsAccountsCapMakesNoPod(t *testing.T) {
	var version, deleted, made atomic.Int32
	api := nodeShellAPI("Pending", &deleted)
	h, store := liveHandler(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			made.Add(1)
		}
		api(w, r)
	}, &version)
	h.cfg = config.Config{NodeShellEnabled: true, NodeShellNamespace: nodeShellTestNamespace, NodeShellImages: []string{"example.test/shell:1"}, NodeShellTimeoutSec: 60}
	h.streamCaps = streamcap.New(1, 0)
	interval := nodeShellPollInterval
	nodeShellPollInterval = 5 * time.Millisecond
	t.Cleanup(func() { nodeShellPollInterval = interval })
	srv := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		h.NodeDebugShellWS(w, asAccount(r, "apps", "resource.node.shell"))
	})

	first := dialTerminal(t, srv, "as=u1")
	if s := readShellStatus(t, first); s.Status != shellWaiting {
		t.Fatalf("first status = %+v", s)
	}
	wantCapClose(t, dialTerminal(t, srv, "as=u1"))
	if got := made.Load(); got != 1 {
		t.Fatalf("debug pods made = %d, want 1", got)
	}
	rows := store.failedRows("k8s.node.shell")
	if len(rows) != 1 || !strings.Contains(rows[0].Error, "multicluster.maxTerminalsPerAccount") {
		t.Fatalf("failed rows = %+v", rows)
	}

	_ = first.Close()
	waitOpen(t, h.streamCaps, "u1", streamcap.Terminal, 0)
	wantDebugPodDeleted(t, &deleted)
}

// openFollow starts an event stream and returns its first event and a cancel that drops the connection.
func openFollow(t *testing.T, srv *httptest.Server, target string) (sseEvent, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+target, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	buf := make([]byte, 4096)
	var got string
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(got, "data: ") && time.Now().Before(deadline) {
		n, err := resp.Body.Read(buf)
		got += string(buf[:n])
		if err != nil {
			break
		}
	}
	var ev sseEvent
	for _, line := range strings.Split(got, "\n") {
		if strings.HasPrefix(line, "event: ") {
			ev.name = strings.TrimPrefix(line, "event: ")
		}
		if strings.HasPrefix(line, "data: ") {
			ev.data = strings.TrimPrefix(line, "data: ")
			break
		}
	}
	return ev, cancel
}

// refusedFollow reads a whole answer that should be the refusal at the account's cap.
func refusedFollow(t *testing.T, srv *httptest.Server, target string) {
	t.Helper()
	// the refusal ends at once; a stream that stays open is no refusal
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get(srv.URL + target)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("the answer did not end: %v, read %q", err, body)
	}
	want := "retry: 30000\nevent: " + streamcap.Event + "\ndata: " + streamcap.FollowedLogReason + "\n\n"
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "text/event-stream" || string(body) != want {
		t.Fatalf("status %d %q body %q, want the event alone", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
}

func TestAFollowedLogPastItsAccountsCapGetsTheEventAndAPlaceComesBackWhenOneEnds(t *testing.T) {
	var ended atomic.Bool
	var version atomic.Int32
	var reads atomic.Int32
	logs := logAPI(&ended)
	h, store := liveHandler(t, func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		logs(w, r)
	}, &version)
	h.streamCaps = streamcap.New(0, 2)
	srv := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodLogsSSE(w, asAccount(r, "apps", "resource.pod.read"))
	})
	first, dropFirst := openFollow(t, srv, "/x?container=app&as=u1")
	second, _ := openFollow(t, srv, "/x?container=app&as=u1")
	if first.data != "line 0" || second.data != "line 0" {
		t.Fatalf("first events %+v %+v", first, second)
	}
	readsBefore := reads.Load()

	refusedFollow(t, srv, "/x?container=app&as=u1")
	if got := reads.Load(); got != readsBefore {
		t.Fatalf("the refused stream read the log (%d reads, want %d)", got, readsBefore)
	}
	rows := store.failedRows("k8s.pod.logs.read")
	if len(rows) != 1 || !strings.Contains(rows[0].Error, "followed logs: this account has 2 open on this server") {
		t.Fatalf("failed rows = %+v", rows)
	}
	if ev, _ := openFollow(t, srv, "/x?container=app&as=u2"); ev.data != "line 0" {
		t.Fatalf("another account's stream: %+v", ev)
	}

	dropFirst()
	waitOpen(t, h.streamCaps, "u1", streamcap.FollowedLog, 1)
	if ev, _ := openFollow(t, srv, "/x?container=app&as=u1"); ev.data != "line 0" {
		t.Fatalf("after a place came back: %+v", ev)
	}
}

func TestAFollowedLogFilePastItsAccountsCapGetsTheEvent(t *testing.T) {
	orig := logFilePollInterval
	logFilePollInterval = 5 * time.Millisecond
	t.Cleanup(func() { logFilePollInterval = orig })
	file := &fakeFile{inode: "11", data: "l1\n"}
	h, _, _ := logFileHandler(t, true, file.run)
	store := &lockedAudit{}
	h.auditStore = store
	var version atomic.Int32
	h.SetLiveSessions(sessionsAt(&version))
	h.streamCaps = streamcap.New(0, 1)
	srv := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		h.LogFileStream(w, asAccount(r, "apps", "resource.pod.logfile"))
	})
	const target = "/x?container=app&path=/var/log/app/app.log&lines=2&as=u1"
	first, dropFirst := openFollow(t, srv, target)
	if first.data != "l1" {
		t.Fatalf("first event %+v", first)
	}
	refusedFollow(t, srv, target) // refused before any command runs in the container
	if rows := store.failedRows(auditLogFileRead); len(rows) != 1 || !strings.Contains(rows[0].Error, "multicluster.maxFollowedLogsPerAccount") {
		t.Fatalf("failed rows = %+v", rows)
	}
	dropFirst()
	waitOpen(t, h.streamCaps, "u1", streamcap.FollowedLog, 0)
}
