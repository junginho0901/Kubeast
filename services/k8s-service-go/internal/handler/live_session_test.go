package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// sessionsAt checks every few milliseconds against a version the test moves.
func sessionsAt(version *atomic.Int32) *auth.LiveSessions {
	return auth.NewLiveSessions(auth.LiveSessionConfig{
		Lookup: func(context.Context, string, string) (auth.SessionState, error) {
			return auth.SessionState{Version: int(version.Load())}, nil
		},
		CheckEvery: 5 * time.Millisecond, CacheTTL: time.Millisecond,
	})
}

// bridgeHeld is bridge with a context the test ends the way LiveSessions does.
func bridgeHeld(t *testing.T, fake *fakeExecutor, lang string) (*websocket.Conn, <-chan error, context.CancelCauseFunc) {
	t.Helper()
	orig := newShellExecutor
	newShellExecutor = func(*rest.Config, *url.URL) (remotecommand.Executor, error) { return fake, nil }
	t.Cleanup(func() { newShellExecutor = orig })
	done := make(chan error, 1)
	endCh := make(chan context.CancelCauseFunc, 1)
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		held, end := context.WithCancelCause(context.Background())
		endCh <- end
		done <- streamShell(held, conn, readFrames(held, conn), &rest.Config{}, &url.URL{Path: "/x"}, nil, lang)
	}))
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c, done, <-endCh
}

func TestAnEndedSessionTellsTheTerminalWhyAndHangsUpTheShell(t *testing.T) {
	withHangupGrace(t, 5*time.Second)
	fake := &fakeExecutor{endOnEOT: true}
	c, done, end := bridgeHeld(t, fake, "")
	readFrame(t, c) // ready
	readFrame(t, c) // prompt
	if err := c.WriteMessage(websocket.TextMessage, []byte("sleep 100")); err != nil {
		t.Fatal(err)
	}
	readFrame(t, c)

	end(&auth.SessionEndError{Code: auth.SessionRevoked})

	if ch, s := readFrame(t, c); ch != shellStderr || !strings.Contains(s, "your account or access changed") {
		t.Fatalf("notice frame = %d %q", ch, s)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err := c.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != auth.SessionEndedCloseCode || closed.Text != auth.SessionRevoked {
		t.Fatalf("after the notice: %v", err)
	}
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
}

// streamUntilCanceled is a stream that only its context ends.
type streamUntilCanceled struct{ started chan struct{} }

func (streamUntilCanceled) Stream(remotecommand.StreamOptions) error { return errors.New("unused") }

func (e streamUntilCanceled) StreamWithContext(ctx context.Context, _ remotecommand.StreamOptions) error {
	close(e.started)
	<-ctx.Done()
	return ctx.Err()
}

func TestACanceledTerminalContextStaysACancel(t *testing.T) {
	exec := streamUntilCanceled{started: make(chan struct{})}
	orig := newShellExecutor
	newShellExecutor = func(*rest.Config, *url.URL) (remotecommand.Executor, error) { return exec, nil }
	t.Cleanup(func() { newShellExecutor = orig })
	done := make(chan error, 1)
	var end context.CancelFunc
	ready := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		held, cancel := context.WithCancel(context.Background())
		end = cancel
		close(ready)
		done <- streamShell(held, conn, readFrames(held, conn), &rest.Config{}, &url.URL{Path: "/x"}, nil, "")
	}))
	defer srv.Close()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	<-ready
	<-exec.started
	end()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("streamShell = %v, want the cancel", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("streamShell did not end with its context")
	}
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := c.ReadMessage(); websocket.IsCloseError(err, auth.SessionEndedCloseCode) {
		t.Fatalf("a plain cancel said the session ended: %v", err)
	}
}

// The handler itself, not only the bridge: its terminal hangs off the caller's session and leaves a row.
func TestAnExecTerminalEndsWithItsSession(t *testing.T) {
	var version atomic.Int32
	h, store := liveHandler(t, func(http.ResponseWriter, *http.Request) {}, &version)
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

	version.Store(1)

	if ch, s := readFrame(t, c); ch != shellStderr || !strings.Contains(s, "your account or access changed") {
		t.Fatalf("notice frame = %d %q", ch, s)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err = c.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != auth.SessionEndedCloseCode {
		t.Fatalf("after the notice: %v", err)
	}
	if row := store.sessionEndRow(t); row["stream"] != "exec" || row["reason"] != auth.SessionRevoked {
		t.Fatalf("session end row = %v", row)
	}
}

func TestSessionEndNoticeFollowsTheScreenLanguageAndTheReason(t *testing.T) {
	for _, tc := range []struct{ code, lang, want string }{
		{auth.SessionRevoked, "en", "your account or access changed"},
		{auth.SessionRevoked, "ko-KR", "계정이나 권한이 바뀌어"},
		{auth.SessionExpired, "", "maximum lifetime"},
		{auth.SessionExpired, "ko", "최대 시간"},
		{auth.SessionSignedOut, "", "this sign-in was signed out"},
		{auth.SessionSignedOut, "ko", "로그아웃되어"},
		{auth.SessionUnverified, "", "could not be verified"},
		{auth.SessionUnverified, "ko", "확인할 수 없어"},
	} {
		if got := sessionEndNotice(tc.code, tc.lang); !strings.Contains(got, tc.want) {
			t.Errorf("%s/%s = %q, want %q", tc.code, tc.lang, got, tc.want)
		}
	}
}

// A terminal whose session could not be checked closes with "try again later" and asks for a new terminal, not a new
// sign-in; one whose session ended closes with 4401 as before.
func TestATerminalWhoseSessionCannotBeCheckedClosesToOpenAgain(t *testing.T) {
	for _, tc := range []struct {
		code, lang string
		close      int
		says, not  string
	}{
		{auth.SessionUnverified, "en", auth.SessionRetryCloseCode, "Open the terminal again", "Sign in"},
		{auth.SessionUnverified, "ko", auth.SessionRetryCloseCode, "터미널을 다시 여세요", "로그인"},
		{auth.SessionRevoked, "en", auth.SessionEndedCloseCode, "Sign in again", "Open the terminal again"},
	} {
		ctx, cancel := context.WithCancelCause(context.Background())
		cancel(&auth.SessionEndError{Code: tc.code})
		notice, close, reason, ok := serverEnded(ctx, tc.lang)
		if !ok || close != tc.close || reason != tc.code || !strings.Contains(notice, tc.says) || strings.Contains(notice, tc.not) {
			t.Errorf("%s/%s: close %d %q ok=%v notice %q, want close %d, %q and not %q", tc.code, tc.lang, close, reason, ok, notice, tc.close, tc.says, tc.not)
		}
	}
}

// lockedAudit takes rows from a handler goroutine while a test waits for one.
type lockedAudit struct {
	mu   sync.Mutex
	rows []audit.Record
}

func (a *lockedAudit) Write(_ context.Context, rec audit.Record) (int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rows = append(a.rows, rec)
	return int64(len(a.rows)), nil
}

// sessionEndRow waits for the row a connection's session end leaves.
func (a *lockedAudit) sessionEndRow(t *testing.T) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		for _, r := range a.rows {
			if r.Action == auditSessionEndAction {
				a.mu.Unlock()
				var after map[string]any
				_ = json.Unmarshal(r.After, &after)
				return after
			}
		}
		a.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no session end row")
	return nil
}

// liveHandler serves one fake API server and returns a handler bound to it.
func liveHandler(t *testing.T, api http.HandlerFunc, version *atomic.Int32) (*Handler, *lockedAudit) {
	t.Helper()
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)
	blob := strings.Replace(middlewareKubeconfig, "https://127.0.0.1:6443", server.URL, 1)
	svc, err := k8s.NewService(context.Background(), canIRegistry{blob: blob}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	store := &lockedAudit{}
	h := &Handler{svc: svc, auditStore: store}
	h.SetLiveSessions(sessionsAt(version))
	return h, store
}

// sseEvents reads an event stream into a channel until it closes.
func sseEvents(t *testing.T, serve http.HandlerFunc, target string) <-chan sseEvent {
	t.Helper()
	srv := httptest.NewServer(serve)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+target, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	events := make(chan sseEvent, 256)
	go func() {
		defer close(events)
		sc := bufio.NewScanner(resp.Body)
		name := ""
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				events <- sseEvent{name, strings.TrimPrefix(line, "data: ")}
				name = ""
			}
		}
	}()
	return events
}

func waitForEvent(t *testing.T, events <-chan sseEvent, want sseEvent) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case got, ok := <-events:
			if !ok {
				t.Fatalf("stream closed before %+v", want)
			}
			if got == want {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %+v", want)
		}
	}
}

// logAPI answers a pod's log with a line every few milliseconds until the caller goes.
func logAPI(ended *atomic.Bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/log") {
			http.NotFound(w, r)
			return
		}
		for i := 0; ; i++ {
			if _, err := fmt.Fprintf(w, "line %d\n", i); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
				ended.Store(true)
				return
			case <-time.After(5 * time.Millisecond):
			}
		}
	}
}

func TestAFollowedLogEndsWithTheReasonWhenItsSessionIsRevoked(t *testing.T) {
	var ended atomic.Bool
	var version atomic.Int32
	h, store := liveHandler(t, logAPI(&ended), &version)
	events := sseEvents(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodLogsSSE(w, withLogFileContext(r, "apps", "resource.pod.read"))
	}, "/x?container=app")
	waitForEvent(t, events, sseEvent{"", "line 0"})

	version.Store(1)

	waitForEvent(t, events, sseEvent{streamEndedEvent, auth.SessionRevoked})
	deadline := time.Now().Add(3 * time.Second)
	for !ended.Load() {
		if time.Now().After(deadline) {
			t.Fatal("the log read on the API server kept running")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if row := store.sessionEndRow(t); row["reason"] != auth.SessionRevoked || row["stream"] != "pod-logs" {
		t.Fatalf("session end row = %v", row)
	}
}

func TestAFollowedLogKeepsFlowingWithoutAGapWhileItsSessionStands(t *testing.T) {
	var ended atomic.Bool
	var version atomic.Int32
	h, _ := liveHandler(t, logAPI(&ended), &version)
	events := sseEvents(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodLogsSSE(w, withLogFileContext(r, "apps", "resource.pod.read"))
	}, "/x?container=app")
	// Many checks go by; every line arrives, in order, on the one connection.
	for i := 0; i < 40; i++ {
		select {
		case got, ok := <-events:
			want := sseEvent{"", fmt.Sprintf("line %d", i)}
			if !ok || got != want {
				t.Fatalf("event %d = %+v (open %v), want %+v", i, got, ok, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no event %d", i)
		}
	}
}

func TestAFollowedLogFileEndsWithTheReasonWhenItsSessionIsRevoked(t *testing.T) {
	orig := logFilePollInterval
	logFilePollInterval = 5 * time.Millisecond
	defer func() { logFilePollInterval = orig }()
	file := &fakeFile{inode: "11", data: "l1\n"}
	h, _, _ := logFileHandler(t, true, file.run)
	store := &lockedAudit{}
	h.auditStore = store
	var version atomic.Int32
	h.SetLiveSessions(sessionsAt(&version))
	events := sseEvents(t, func(w http.ResponseWriter, r *http.Request) {
		h.LogFileStream(w, withLogFileContext(r, "apps", "resource.pod.logfile"))
	}, "/x?container=app&path=/var/log/app/app.log&lines=2")
	waitForEvent(t, events, sseEvent{"", "l1"})

	version.Store(1)

	waitForEvent(t, events, sseEvent{streamEndedEvent, auth.SessionRevoked})
	if _, open := <-events; open {
		t.Fatal("the stream went on after saying its session ended")
	}
	if row := store.sessionEndRow(t); row["stream"] != "log-file" {
		t.Fatalf("session end row = %v", row)
	}
}

func TestAHelmWatchEndsWithTheReasonWhenItsSessionIsRevoked(t *testing.T) {
	var version atomic.Int32
	h, _ := liveHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}, &version)
	opened := make(chan struct{})
	events := sseEvents(t, func(w http.ResponseWriter, r *http.Request) {
		close(opened)
		ctx := cluster.WithID(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}), "c")
		h.WatchHelmReleases(w, r.WithContext(ctx))
	}, "/x")
	<-opened
	version.Store(1)
	waitForEvent(t, events, sseEvent{streamEndedEvent, auth.SessionRevoked})
}

// cancelAwareAudit refuses a write on a cancelled context, as the Postgres store does.
type cancelAwareAudit struct {
	audit.Reader
	rows      []audit.Record
	deadlines []time.Duration
}

func (a *cancelAwareAudit) Write(ctx context.Context, rec audit.Record) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, fmt.Errorf("audit insert: %w", err)
	}
	if d, ok := ctx.Deadline(); ok {
		a.deadlines = append(a.deadlines, time.Until(d))
	}
	a.rows = append(a.rows, rec)
	return int64(len(a.rows)), nil
}

// probeRefused answers pings but refuses a probe write, so Ready fails only after a failed write.
type probeRefused struct{}

func (probeRefused) Ping(context.Context) error       { return nil }
func (probeRefused) ProbeWrite(context.Context) error { return errors.New("probe refused") }

func TestTheSessionEndRowIsStoredAfterTheBrowserClosed(t *testing.T) {
	store := &cancelAwareAudit{}
	guarded := audit.Guard(store, probeRefused{}, true)
	h := &Handler{auditStore: guarded}

	reqCtx, closeRequest := context.WithCancel(cluster.WithID(auth.WithPayload(context.Background(),
		auth.TokenPayload{UserID: "u1", Email: "u1@example.com"}), "c"))
	r := httptest.NewRequest(http.MethodGet, "/api/v1/namespaces/ns/pods/p/logs/stream", nil).WithContext(reqCtx)
	r.Header.Set("X-Request-ID", "req-1")
	held, end := context.WithCancelCause(reqCtx)
	end(&auth.SessionEndError{Code: auth.SessionRevoked})
	closeRequest() // the browser closed on the end frame

	h.auditSessionEnd(held, r, "pod", "p", "ns", "pod-logs")

	if len(store.rows) != 1 {
		t.Fatalf("rows = %d, want the session end row", len(store.rows))
	}
	row := store.rows[0]
	if row.Action != auditSessionEndAction || row.ActorUserID != "u1" || row.ActorEmail != "u1@example.com" || row.Cluster != "c" || row.RequestID != "req-1" {
		t.Fatalf("row = %+v", row)
	}
	if len(store.deadlines) != 1 || store.deadlines[0] <= 0 || store.deadlines[0] > auditAfterCloseTimeout {
		t.Fatalf("write deadline = %v, want within %v", store.deadlines, auditAfterCloseTimeout)
	}
	if st := guarded.Status(context.Background()); st.WriteFailures != 0 {
		t.Fatalf("write failures = %d (%s)", st.WriteFailures, st.LastError)
	}
	if err := guarded.Ready(context.Background()); err != nil {
		t.Fatalf("store marked broken: %v", err)
	}
}

// A mutation handler writes its row on the request's context after the change
// ran; a browser that closed the connection by then (net/http cancels that
// context) does not take the row with it.
func TestAMutationsRowIsStoredAfterTheBrowserClosed(t *testing.T) {
	store := &cancelAwareAudit{}
	guarded := audit.Guard(store, probeRefused{}, true)
	h := &Handler{auditStore: guarded}

	reqCtx, closeRequest := context.WithCancel(cluster.WithID(auth.WithPayload(context.Background(),
		auth.TokenPayload{UserID: "u1", Email: "u1@example.com"}), "c"))
	r := httptest.NewRequest(http.MethodDelete, "/api/v1/namespaces/ns/pods/p", nil).WithContext(reqCtx)
	r.Header.Set("X-Request-ID", "req-1")
	closeRequest() // the browser left while the delete ran

	if err := h.recordAudit(r, "k8s.pod.delete", "pod", "p", "ns", nil); err != nil {
		t.Fatalf("recordAudit after the browser left: %v", err)
	}
	if len(store.rows) != 1 {
		t.Fatalf("rows = %d, want the delete's row", len(store.rows))
	}
	row := store.rows[0]
	if row.Action != "k8s.pod.delete" || row.Result != audit.ResultSuccess || row.ActorUserID != "u1" || row.Cluster != "c" || row.RequestID != "req-1" {
		t.Fatalf("row = %+v", row)
	}
	if len(store.deadlines) != 0 {
		t.Fatalf("write deadline = %v, want none: the request had none", store.deadlines)
	}
	if st := guarded.Status(context.Background()); st.WriteFailures != 0 {
		t.Fatalf("write failures = %d (%s)", st.WriteFailures, st.LastError)
	}
	if err := guarded.Ready(context.Background()); err != nil {
		t.Fatalf("store marked broken: %v", err)
	}
}

func TestAStreamEndedByItsClientSaysNothing(t *testing.T) {
	rec := httptest.NewRecorder()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if sayStreamEnded(ctx, rec, rec) || rec.Body.Len() != 0 {
		t.Fatalf("wrote %q for a plain cancel", rec.Body)
	}
}
