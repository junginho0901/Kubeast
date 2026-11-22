package handler

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/streamcap"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// The server's cap (multicluster.maxStreamsPerServer) counts the terminals and followed logs of every account together.
// These tests hold that one past it is refused before anything opens, in the shape of an account's cap, and that a
// place given back opens one again.

// wantCapCloseWith reads the socket's next frame as the close of a terminal refused at a cap with reason.
func wantCapCloseWith(t *testing.T, c *websocket.Conn, reason string) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := c.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != streamcap.CloseCode || closed.Text != reason {
		t.Fatalf("got frame %q, err %v; want close %d %q", data, err, streamcap.CloseCode, reason)
	}
}

func waitTotal(t *testing.T, caps *streamcap.Caps, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for caps.Total() != want {
		if time.Now().After(deadline) {
			t.Fatalf("the server holds %d, want %d", caps.Total(), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// refusedFollowWith reads a whole answer that should be the refusal of a followed log at a cap with reason.
func refusedFollowWith(t *testing.T, srv *httptest.Server, target, reason string) {
	t.Helper()
	// the refusal ends at once; a stream that stays open is no refusal
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get(srv.URL + target)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("the answer did not end: %v, began %q", err, body[:min(len(body), 120)])
	}
	want := "retry: 30000\nevent: " + streamcap.Event + "\ndata: " + reason + "\n\n"
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "text/event-stream" || string(body) != want {
		t.Fatalf("status %d %q body %q, want the event alone", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
}

// serverCapsExecHandler is execCapsHandler with caps of terminals for each account and server for the server.
func serverCapsExecHandler(t *testing.T, terminals, server int) (*Handler, *lockedAudit, *httptest.Server) {
	t.Helper()
	var version atomic.Int32
	h, store := liveHandler(t, func(http.ResponseWriter, *http.Request) {}, &version)
	h.streamCaps = streamcap.NewWithServerCap(terminals, 0, server)
	fake := &fakeExecutor{endOnEOT: true}
	orig := newShellExecutor
	newShellExecutor = func(*rest.Config, *url.URL) (remotecommand.Executor, error) { return fake, nil }
	t.Cleanup(func() { newShellExecutor = orig })
	srv := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodExecWS(w, asAccount(r, "apps", "resource.pod.exec"))
	})
	return h, store, srv
}

const serverCapRowText = "this server has 2 terminals and followed logs open, the most it may (multicluster.maxStreamsPerServer)"

// Accounts each under their own cap fill the server: the next terminal, of any account, gets no shell, with the close
// the screen reads and a failed row naming the value; a terminal that ends gives the server its place back.
func TestAnExecTerminalPastTheServersCapIsRefusedAndAPlaceComesBackWhenOneEnds(t *testing.T) {
	h, store, srv := serverCapsExecHandler(t, 20, 2)
	first := openShell(t, srv, "u1")
	openShell(t, srv, "u2")
	waitTotal(t, h.streamCaps, 2)

	wantCapCloseWith(t, dialTerminal(t, srv, "container=app&as=u3"), streamcap.ServerReason)
	rows := store.failedRows("k8s.pod.exec")
	if len(rows) != 1 || !strings.Contains(rows[0].Error, "terminals: "+serverCapRowText) || rows[0].ActorUserID != "u3" {
		t.Fatalf("failed rows = %+v, want one saying the server's cap", rows)
	}
	if got := h.streamCaps.Total(); got != 2 {
		t.Fatalf("the server holds %d after the refusal, want 2", got)
	}
	if got := h.streamCaps.ServerRefused(streamcap.Terminal); got != 1 {
		t.Fatalf("server refusals = %d, want 1", got)
	}
	if got := h.streamCaps.Refused(streamcap.Terminal); got != 0 {
		t.Fatalf("account refusals = %d, want 0: no account held its cap", got)
	}

	// The first shell exits on its own.
	if err := first.WriteMessage(websocket.TextMessage, []byte{0x04}); err != nil {
		t.Fatal(err)
	}
	waitTotal(t, h.streamCaps, 1)
	openShell(t, srv, "u3")
	if rows := store.failedRows("k8s.pod.exec"); len(rows) != 1 {
		t.Fatalf("failed rows = %d after the place came back, want still 1", len(rows))
	}
}

// One terminal and one followed log fill a server whose cap is 2: the next followed log reads nothing from the cluster
// and gets the event with the server's reason, the next terminal the close; a terminal that ends opens a followed log.
func TestTheServersCapCountsTerminalsAndFollowedLogsTogether(t *testing.T) {
	var ended atomic.Bool
	var version, reads atomic.Int32
	logs := logAPI(&ended)
	h, store := liveHandler(t, func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		logs(w, r)
	}, &version)
	h.streamCaps = streamcap.NewWithServerCap(20, 20, 2)
	fake := &fakeExecutor{endOnEOT: true}
	orig := newShellExecutor
	newShellExecutor = func(*rest.Config, *url.URL) (remotecommand.Executor, error) { return fake, nil }
	t.Cleanup(func() { newShellExecutor = orig })
	execSrv := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodExecWS(w, asAccount(r, "apps", "resource.pod.exec"))
	})
	logSrv := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodLogsSSE(w, asAccount(r, "apps", "resource.pod.read"))
	})

	shell := openShell(t, execSrv, "u1")
	if ev, _ := openFollow(t, logSrv, "/x?container=app&as=u2"); ev.data != "line 0" {
		t.Fatalf("u2's followed log: %+v", ev)
	}
	waitTotal(t, h.streamCaps, 2)
	readsBefore := reads.Load()

	refusedFollowWith(t, logSrv, "/x?container=app&as=u3", streamcap.ServerReason)
	if got := reads.Load(); got != readsBefore {
		t.Fatalf("the refused stream read the log (%d reads, want %d)", got, readsBefore)
	}
	if rows := store.failedRows("k8s.pod.logs.read"); len(rows) != 1 || !strings.Contains(rows[0].Error, "followed logs: "+serverCapRowText) {
		t.Fatalf("failed log rows = %+v", rows)
	}
	wantCapCloseWith(t, dialTerminal(t, execSrv, "container=app&as=u3"), streamcap.ServerReason)
	if rows := store.failedRows("k8s.pod.exec"); len(rows) != 1 || !strings.Contains(rows[0].Error, "terminals: "+serverCapRowText) {
		t.Fatalf("failed exec rows = %+v", rows)
	}
	if h.streamCaps.ServerRefused(streamcap.Terminal) != 1 || h.streamCaps.ServerRefused(streamcap.FollowedLog) != 1 {
		t.Fatalf("server refusals = %d terminals, %d followed logs, want 1 and 1",
			h.streamCaps.ServerRefused(streamcap.Terminal), h.streamCaps.ServerRefused(streamcap.FollowedLog))
	}

	// The shell exits: its place opens u3's followed log.
	if err := shell.WriteMessage(websocket.TextMessage, []byte{0x04}); err != nil {
		t.Fatal(err)
	}
	waitTotal(t, h.streamCaps, 1)
	if ev, _ := openFollow(t, logSrv, "/x?container=app&as=u3"); ev.data != "line 0" {
		t.Fatalf("after a place came back: %+v", ev)
	}
}

// With both caps, the one reached first refuses; an account at its own cap on a full server is told of its own, since
// closing one of its terminals gives the server a place back too.
func TestAnAccountAtItsCapOnAFullServerIsToldOfItsOwnCap(t *testing.T) {
	h, store, srv := serverCapsExecHandler(t, 1, 2)
	openShell(t, srv, "u1")
	openShell(t, srv, "u2")
	waitTotal(t, h.streamCaps, 2)

	wantCapCloseWith(t, dialTerminal(t, srv, "container=app&as=u1"), streamcap.TerminalReason)
	wantCapCloseWith(t, dialTerminal(t, srv, "container=app&as=u3"), streamcap.ServerReason)
	rows := store.failedRows("k8s.pod.exec")
	if len(rows) != 2 {
		t.Fatalf("failed rows = %+v, want two", rows)
	}
	if rows[0].ActorUserID != "u1" || !strings.Contains(rows[0].Error, "this account has 1 open on this server, the most it may (multicluster.maxTerminalsPerAccount)") {
		t.Fatalf("u1's row = %+v, want its account's cap", rows[0])
	}
	if rows[1].ActorUserID != "u3" || !strings.Contains(rows[1].Error, "(multicluster.maxStreamsPerServer)") {
		t.Fatalf("u3's row = %+v, want the server's cap", rows[1])
	}
	if h.streamCaps.Refused(streamcap.Terminal) != 1 || h.streamCaps.ServerRefused(streamcap.Terminal) != 1 {
		t.Fatalf("refusals = %d at the account's cap, %d at the server's, want 1 and 1",
			h.streamCaps.Refused(streamcap.Terminal), h.streamCaps.ServerRefused(streamcap.Terminal))
	}
}

func TestNoServerCapWithZeroOnTheHandler(t *testing.T) {
	h, store, srv := serverCapsExecHandler(t, 0, 0)
	for _, as := range []string{"u1", "u2", "u3", "u4", "u5"} {
		openShell(t, srv, as)
	}
	waitTotal(t, h.streamCaps, 5)
	if rows := store.failedRows("k8s.pod.exec"); len(rows) != 0 {
		t.Fatalf("failed rows = %+v with no cap", rows)
	}
}

// A node shell past the server's cap makes no debug pod.
func TestANodeShellPastTheServersCapMakesNoPod(t *testing.T) {
	var version, deleted, made atomic.Int32
	api := nodeShellAPI("Pending", &deleted)
	h, store := liveHandler(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			made.Add(1)
		}
		api(w, r)
	}, &version)
	h.cfg = config.Config{NodeShellEnabled: true, NodeShellNamespace: nodeShellTestNamespace, NodeShellImages: []string{"example.test/shell:1"}, NodeShellTimeoutSec: 60}
	h.streamCaps = streamcap.NewWithServerCap(20, 20, 1)
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
	wantCapCloseWith(t, dialTerminal(t, srv, "as=u2"), streamcap.ServerReason)
	if got := made.Load(); got != 1 {
		t.Fatalf("debug pods made = %d, want 1", got)
	}
	rows := store.failedRows("k8s.node.shell")
	if len(rows) != 1 || !strings.Contains(rows[0].Error, "multicluster.maxStreamsPerServer") {
		t.Fatalf("failed rows = %+v", rows)
	}

	_ = first.Close()
	waitTotal(t, h.streamCaps, 0)
	wantDebugPodDeleted(t, &deleted)
}

// A followed log file past the server's cap runs nothing in the container.
func TestAFollowedLogFilePastTheServersCapRunsNothing(t *testing.T) {
	orig := logFilePollInterval
	logFilePollInterval = 5 * time.Millisecond
	t.Cleanup(func() { logFilePollInterval = orig })
	file := &fakeFile{inode: "11", data: "l1\n"}
	var commands atomic.Int32
	h, _, _ := logFileHandler(t, true, func(argv []string) fakeCommand {
		commands.Add(1)
		return file.run(argv)
	})
	store := &lockedAudit{}
	h.auditStore = store
	var version atomic.Int32
	h.SetLiveSessions(sessionsAt(&version))
	h.streamCaps = streamcap.NewWithServerCap(20, 20, 1)
	srv := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		h.LogFileStream(w, asAccount(r, "apps", "resource.pod.logfile"))
	})
	const target = "/x?container=app&path=/var/log/app/app.log&lines=2&as=u1"
	// The server's one place is held by another account's terminal.
	held, ok := h.streamCaps.Take("u9", streamcap.Terminal)
	if !ok {
		t.Fatal("the first place was refused")
	}
	refusedFollowWith(t, srv, target, streamcap.ServerReason)
	if got := commands.Load(); got != 0 {
		t.Fatalf("%d commands ran in the container for the refused stream, want 0", got)
	}
	if rows := store.failedRows(auditLogFileRead); len(rows) != 1 || !strings.Contains(rows[0].Error, "multicluster.maxStreamsPerServer") {
		t.Fatalf("failed rows = %+v", rows)
	}
	held()
	first, dropFirst := openFollow(t, srv, target)
	if first.data != "l1" {
		t.Fatalf("first event after the place came back %+v", first)
	}
	dropFirst()
	waitTotal(t, h.streamCaps, 0)
}
