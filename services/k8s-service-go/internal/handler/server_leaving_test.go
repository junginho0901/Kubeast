package handler

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/drain"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// bridgeDrained is bridge with the terminal held by d, as PodExecWS holds it.
func bridgeDrained(t *testing.T, fake *fakeExecutor, lang string, d *drain.Drain) (*websocket.Conn, <-chan error) {
	t.Helper()
	orig := newShellExecutor
	newShellExecutor = func(*rest.Config, *url.URL) (remotecommand.Executor, error) { return fake, nil }
	t.Cleanup(func() { newShellExecutor = orig })
	done := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		held, leave := d.HoldTerminal(context.Background())
		defer leave()
		done <- streamShell(held, conn, readFrames(held, conn), &rest.Config{}, &url.URL{Path: "/x"}, nil, lang)
	}))
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c, done
}

func wantServerLeftClose(t *testing.T, c *websocket.Conn) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err := c.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != websocket.CloseGoingAway || closed.Text != drain.Code {
		t.Fatalf("after the notice: %v, want close 1001 %q", err, drain.Code)
	}
}

func TestAServerLeavingTellsTheTerminalWhenItClosesThenClosesItAndHangsUpTheShell(t *testing.T) {
	withHangupGrace(t, 5*time.Second)
	fake := &fakeExecutor{endOnEOT: true}
	d := drain.New()
	c, done := bridgeDrained(t, fake, "ko", d)
	readFrame(t, c) // ready
	readFrame(t, c) // prompt
	if err := c.WriteMessage(websocket.TextMessage, []byte("sleep 100")); err != nil {
		t.Fatal(err)
	}
	readFrame(t, c)

	ran := make(chan drain.Result, 1)
	go func() { ran <- d.Run(2*time.Second, 5*time.Second) }()

	if ch, s := readFrame(t, c); ch != shellStderr || !strings.Contains(s, "서버를 교체하고 있습니다") || !strings.Contains(s, "2초 뒤") {
		t.Fatalf("warning frame = %d %q, want when it closes in Korean", ch, s)
	}
	if ch, s := readFrame(t, c); ch != shellStderr || !strings.Contains(s, "서버가 교체되어") {
		t.Fatalf("notice frame = %d %q", ch, s)
	}
	wantServerLeftClose(t, c)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("streamShell = %v, want nil: the terminal already said why", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the shell was left running")
	}
	if got := fake.gotStdin(); !bytes.HasSuffix(got, []byte("sleep 100\x03\x04")) {
		t.Fatalf("stdin = %q, want the hang-up keys after the typed line", got)
	}
	if res := <-ran; res.TerminalsCut != 1 || res.Unreleased != 0 {
		t.Fatalf("drain %+v", res)
	}
}

func TestATerminalThatEndsWithinTheWaitIsNotCut(t *testing.T) {
	fake := &fakeExecutor{endOnEOT: true}
	d := drain.New()
	c, done := bridgeDrained(t, fake, "", d)
	readFrame(t, c) // ready
	readFrame(t, c) // prompt
	ran := make(chan drain.Result, 1)
	go func() { ran <- d.Run(time.Hour, 5*time.Second) }()
	if ch, s := readFrame(t, c); ch != shellStderr || !strings.Contains(s, "this terminal closes in 3600 s") {
		t.Fatalf("warning frame = %d %q", ch, s)
	}
	// the person finishes and leaves: Ctrl-D
	if err := c.WriteMessage(websocket.TextMessage, []byte{0x04}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("streamShell = %v", err)
	}
	select {
	case res := <-ran:
		if res.TerminalsLeft != 1 || res.TerminalsCut != 0 {
			t.Fatalf("drain %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the drain waited the hour although the terminal had ended")
	}
}

func TestServerLeavingNoticesFollowTheScreenLanguage(t *testing.T) {
	for _, tc := range []struct {
		lang string
		in   time.Duration
		want string
	}{
		{"", 60 * time.Second, "this terminal closes in 60 s"},
		{"en", 59600 * time.Millisecond, "this terminal closes in 60 s"},
		{"ko-KR", 30 * time.Second, "이 터미널은 30초 뒤 닫힙니다"},
		{"ko", -time.Second, "0초 뒤"},
	} {
		if got := serverLeavingNotice(tc.in, tc.lang); !strings.Contains(got, tc.want) {
			t.Errorf("%q %v = %q, want %q", tc.lang, tc.in, got, tc.want)
		}
	}
	if got := serverLeftNotice("ko"); !strings.Contains(got, "새 터미널을 여세요") {
		t.Errorf("ko = %q", got)
	}
	if got := serverLeftNotice(""); !strings.Contains(got, "the server was replaced") {
		t.Errorf("en = %q", got)
	}
}

// The handler: its terminal is held by the drain, ends with the reason and leaves a row.
func TestAnExecTerminalEndsWhenItsServerIsReplacedAndLeavesARow(t *testing.T) {
	var version atomic.Int32
	h, store := liveHandler(t, func(http.ResponseWriter, *http.Request) {}, &version)
	d := drain.New()
	h.SetDrain(d)
	fake := &fakeExecutor{endOnEOT: true}
	orig := newShellExecutor
	newShellExecutor = func(*rest.Config, *url.URL) (remotecommand.Executor, error) { return fake, nil }
	t.Cleanup(func() { newShellExecutor = orig })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.PodExecWS(w, withLogFileContext(r, "apps", "resource.pod.exec"))
	}))
	defer srv.Close()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"?container=app", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	readFrame(t, c) // ready
	readFrame(t, c) // prompt
	if terminals, _ := d.Open(); terminals != 1 {
		t.Fatalf("the drain holds %d terminals, want the exec", terminals)
	}

	ran := make(chan drain.Result, 1)
	go func() { ran <- d.Run(0, 5*time.Second) }()

	for {
		ch, s := readFrame(t, c)
		if ch != shellStderr {
			t.Fatalf("frame %d %q before the notice", ch, s)
		}
		if strings.Contains(s, "the server was replaced") {
			break
		}
	}
	wantServerLeftClose(t, c)
	if row := store.sessionEndRow(t); row["stream"] != "exec" || row["reason"] != drain.Code {
		t.Fatalf("session end row = %v", row)
	}
	if res := <-ran; res.Unreleased != 0 {
		t.Fatalf("drain %+v: the handler did not let go", res)
	}
}

func TestATerminalAskedOfALeavingServerIsRefusedBeforeTheUpgradeWithNoRow(t *testing.T) {
	var version atomic.Int32
	h, store := liveHandler(t, func(http.ResponseWriter, *http.Request) {}, &version)
	h.cfg = config.Config{NodeShellEnabled: true, NodeShellNamespace: nodeShellTestNamespace, NodeShellImages: []string{"example.test/shell:1"}}
	d := drain.New()
	h.SetDrain(d)
	d.Run(0, 0)
	for name, serve := range map[string]http.HandlerFunc{
		"exec": func(w http.ResponseWriter, r *http.Request) {
			h.PodExecWS(w, withLogFileContext(r, "apps", "resource.pod.exec"))
		},
		"node shell": func(w http.ResponseWriter, r *http.Request) {
			h.NodeDebugShellWS(w, withLogFileContext(r, "apps", "resource.node.shell"))
		},
	} {
		srv := httptest.NewServer(serve)
		_, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"?container=app", nil)
		srv.Close()
		if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
			t.Errorf("%s: %v, status %v, want 503 before the upgrade", name, err, resp)
		}
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.rows) != 0 {
		t.Fatalf("rows %v, want none: no session was opened", store.rows)
	}
}

func TestAFollowedLogEndsAtOnceWhenItsServerStartsLeavingAndLeavesARow(t *testing.T) {
	var ended atomic.Bool
	var version atomic.Int32
	h, store := liveHandler(t, logAPI(&ended), &version)
	d := drain.New()
	h.SetDrain(d)
	events := sseEvents(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodLogsSSE(w, withLogFileContext(r, "apps", "resource.pod.read"))
	}, "/x?container=app")
	waitForEvent(t, events, sseEvent{"", "line 0"})

	start := time.Now()
	res := d.Run(time.Hour, 5*time.Second)
	if took := time.Since(start); took > 5*time.Second || res.Streams != 1 {
		t.Fatalf("drain %+v after %v: a followed log does not wait", res, took)
	}
	waitForEvent(t, events, sseEvent{serverLeavingEvent, drain.Code})
	deadline := time.Now().Add(3 * time.Second)
	for !ended.Load() {
		if time.Now().After(deadline) {
			t.Fatal("the log read on the API server kept running")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if row := store.sessionEndRow(t); row["reason"] != drain.Code || row["stream"] != "pod-logs" {
		t.Fatalf("session end row = %v", row)
	}
}

func TestAFollowedLogFileEndsWhenItsServerStartsLeaving(t *testing.T) {
	orig := logFilePollInterval
	logFilePollInterval = 5 * time.Millisecond
	defer func() { logFilePollInterval = orig }()
	file := &fakeFile{inode: "11", data: "l1\n"}
	h, _, _ := logFileHandler(t, true, file.run)
	store := &lockedAudit{}
	h.auditStore = store
	d := drain.New()
	h.SetDrain(d)
	events := sseEvents(t, func(w http.ResponseWriter, r *http.Request) {
		h.LogFileStream(w, withLogFileContext(r, "apps", "resource.pod.logfile"))
	}, "/x?container=app&path=/var/log/app/app.log&lines=2")
	waitForEvent(t, events, sseEvent{"", "l1"})

	go d.Run(time.Hour, 5*time.Second)

	waitForEvent(t, events, sseEvent{serverLeavingEvent, drain.Code})
	if _, open := <-events; open {
		t.Fatal("the stream went on after saying its server is leaving")
	}
	if row := store.sessionEndRow(t); row["stream"] != "log-file" || row["reason"] != drain.Code {
		t.Fatalf("session end row = %v", row)
	}
}

// A browser coming back to a server already leaving is sent on again before anything is read or written.
func TestAFollowedLogAskedOfALeavingServerGetsOnlyTheFrameThatSendsItElsewhere(t *testing.T) {
	var calls atomic.Int32
	var version atomic.Int32
	h, store := liveHandler(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.NotFound(w, r)
	}, &version)
	d := drain.New()
	h.SetDrain(d)
	d.Run(0, 0)
	// the log files view on, its commands counted with the cluster calls
	files, fileRows, _ := logFileHandler(t, true, func([]string) fakeCommand { calls.Add(1); return fakeCommand{} })
	files.SetDrain(d)
	want := "retry: 1000\nevent: server-shutdown\ndata: server_shutdown\n\n"
	for name, serve := range map[string]http.HandlerFunc{
		"pod logs": func(w http.ResponseWriter, r *http.Request) {
			h.PodLogsSSE(w, withLogFileContext(r, "apps", "resource.pod.read"))
		},
		"log file": func(w http.ResponseWriter, r *http.Request) {
			files.LogFileStream(w, withLogFileContext(r, "apps", "resource.pod.logfile"))
		},
	} {
		rec := httptest.NewRecorder()
		serve(rec, httptest.NewRequest(http.MethodGet, "/x?container=app&path=/var/log/app/app.log", nil))
		if rec.Code != http.StatusOK || rec.Body.String() != want || rec.Header().Get("Content-Type") != "text/event-stream" {
			t.Errorf("%s: %d %q %q, want 200 and only %q", name, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String(), want)
		}
	}
	if n := calls.Load(); n != 0 {
		t.Errorf("%d calls to the cluster", n)
	}
	if len(fileRows.rows) != 0 {
		t.Errorf("log file rows %v, want none", fileRows.rows)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.rows) != 0 {
		t.Fatalf("rows %v, want none", store.rows)
	}
}

func TestANodeShellStillStartingEndsWithTheReasonWhenItsServerLeaves(t *testing.T) {
	var version, deleted atomic.Int32
	h, store := liveHandler(t, nodeShellAPI("Pending", &deleted), &version)
	h.cfg = config.Config{NodeShellEnabled: true, NodeShellNamespace: nodeShellTestNamespace, NodeShellImages: []string{"example.test/shell:1"}, NodeShellTimeoutSec: 60}
	d := drain.New()
	h.SetDrain(d)
	interval := nodeShellPollInterval
	nodeShellPollInterval = 5 * time.Millisecond
	t.Cleanup(func() { nodeShellPollInterval = interval })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.NodeDebugShellWS(w, withLogFileContext(r, "apps", "resource.node.shell"))
	}))
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"?lang=ko", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	if s := readShellStatus(t, c); s.Status != shellWaiting {
		t.Fatalf("status %+v", s)
	}

	go d.Run(0, 5*time.Second)

	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("no notice: %v", err)
		}
		if strings.Contains(string(data), "서버가 교체되어") {
			break
		}
	}
	wantServerLeftClose(t, c)
	wantDebugPodDeleted(t, &deleted)
	if row := store.shellRow(t); row.Result != "failure" || !strings.Contains(row.Error, "server shutting down") {
		t.Fatalf("shell row %+v, want the failure the server's leaving caused", row)
	}
}

func TestReadyIsUnreadyOnceTheServerStartsLeavingAndHealthStays(t *testing.T) {
	h := &Handler{}
	h.SetDrain(drain.New())
	rec := httptest.NewRecorder()
	h.Ready(rec, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("ready = %d before leaving", rec.Code)
	}
	h.drain.Run(0, 0)
	rec = httptest.NewRecorder()
	h.Ready(rec, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready = %d while leaving, want 503", rec.Code)
	}
}

func TestWithoutADrainNothingIsRefusedOrHeld(t *testing.T) {
	h := &Handler{}
	rec := httptest.NewRecorder()
	if h.refuseWhileLeaving(rec) || h.refuseTerminalWhileLeaving(rec) || rec.Body.Len() != 0 {
		t.Fatal("refused without a drain")
	}
	h.Ready(rec, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("ready = %d", rec.Code)
	}
}
