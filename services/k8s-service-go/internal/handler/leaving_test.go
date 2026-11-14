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
	"github.com/junginho0901/kubeast/services/pkg/probe"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// A terminal whose server leaves (SIGTERM) says so, closes with 1001 and hangs its shell up, as the browser going away
// does: nothing is left running in the container.
func TestAServerLeavingTellsTheTerminalAndHangsUpTheShell(t *testing.T) {
	withHangupGrace(t, 5*time.Second)
	fake := &fakeExecutor{endOnEOT: true}
	c, done, end := bridgeHeld(t, fake, "")
	readFrame(t, c) // ready
	readFrame(t, c) // prompt
	if err := c.WriteMessage(websocket.TextMessage, []byte("sleep 100")); err != nil {
		t.Fatal(err)
	}
	readFrame(t, c)

	end(probe.ErrLeaving)

	if ch, s := readFrame(t, c); ch != shellStderr || !strings.Contains(s, "the server is restarting") {
		t.Fatalf("notice frame = %d %q", ch, s)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err := c.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != probe.ShutdownCloseCode || closed.Text != probe.ShutdownReason {
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

func TestServerLeavingNoticeFollowsTheScreenLanguage(t *testing.T) {
	if got := serverRestartNotice("ko-KR"); !strings.Contains(got, "서버가 다시 시작되어") {
		t.Fatalf("ko notice = %q", got)
	}
	if got := serverRestartNotice(""); !strings.Contains(got, "Open the terminal again") {
		t.Fatalf("default notice = %q", got)
	}
}

// An event stream the server's leaving ended gives the browser a short reconnection time and is no session's end:
// EventSource asks again, with Last-Event-ID, and a pod that stays answers.
func TestAStreamEndedByTheServerLeavingAsksTheBrowserBackSoon(t *testing.T) {
	p := probe.New()
	ctx, release := p.Hold(context.Background())
	defer release()
	p.Leave()
	<-ctx.Done()
	rec := httptest.NewRecorder()
	if sayStreamEnded(ctx, rec, rec) {
		t.Fatal("a stream the server's leaving ended was told its session ended")
	}
	if got := rec.Body.String(); got != "retry: 1000\n\n" {
		t.Fatalf("wrote %q, want the reconnection time alone", got)
	}
}

// Every long-lived answer goes through holdSession, so the server's leaving reaches each one.
func TestHoldSessionEndsWhenTheServerLeaves(t *testing.T) {
	p := probe.New()
	h := &Handler{leaving: p}
	ctx, release := h.holdSession(context.Background())
	if p.Held() != 1 {
		t.Fatalf("held = %d, want 1", p.Held())
	}
	p.Leave()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("the held answer did not end when the server left")
	}
	if !probe.IsLeaving(ctx) {
		t.Fatalf("cause = %v", context.Cause(ctx))
	}
	release()
	if p.Held() != 0 {
		t.Fatalf("held = %d after the release", p.Held())
	}
}

// The handler itself: an exec terminal the server's leaving closed leaves a k8s.session.end row with server_shutdown,
// beside the row that opened it, and lets go of its hold.
func TestAnExecTerminalTheServerLeavingClosedLeavesItsRow(t *testing.T) {
	var version atomic.Int32
	h, store := liveHandler(t, func(http.ResponseWriter, *http.Request) {}, &version)
	p := probe.New()
	h.SetLeaving(p)
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

	p.Leave()

	if ch, s := readFrame(t, c); ch != shellStderr || !strings.Contains(s, "the server is restarting") {
		t.Fatalf("notice frame = %d %q", ch, s)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err = c.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != probe.ShutdownCloseCode {
		t.Fatalf("after the notice: %v", err)
	}
	if row := store.sessionEndRow(t); row["stream"] != "exec" || row["reason"] != probe.ShutdownReason {
		t.Fatalf("session end row = %v", row)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !p.Wait(ctx) {
		t.Fatalf("the terminal still holds the server (held %d)", p.Held())
	}
}

// closeOrder is a recording that notes how many connections still held the server when it closed.
type closeOrder struct {
	p        *probe.Probe
	heldThen int64
	closed   bool
}

func (c *closeOrder) Close() {
	c.heldThen, c.closed = c.p.Held(), true
}

// The recording closes while the terminal still holds the server, so the recorder's Shutdown, which runs once no hold
// is left, never takes it for a recording the server cut off.
func TestATerminalClosesItsRecordingBeforeItLetsGoOfTheServer(t *testing.T) {
	p := probe.New()
	_, release := p.Hold(context.Background())
	rec := &closeOrder{p: p}
	endTerminal(rec, release)
	if !rec.closed || rec.heldThen != 1 {
		t.Fatalf("closed %v with %d held, want closed while its hold stood", rec.closed, rec.heldThen)
	}
	if p.Held() != 0 {
		t.Fatalf("held = %d after endTerminal", p.Held())
	}
}

// Merge plan S21: with the terminals handed over (the drain of #824 is set), the server's leaving ends a followed log
// at once and leaves a terminal's context to the drain.
func TestATerminalHandedOverOutlivesTheServerLeaving(t *testing.T) {
	p := probe.New()
	p.HandOverTerminals()
	h := &Handler{leaving: p}
	terminal, releaseTerminal := h.holdTerminal(context.Background())
	defer releaseTerminal()
	stream, releaseStream := h.holdSession(context.Background())
	defer releaseStream()
	p.Leave()
	select {
	case <-stream.Done():
	case <-time.After(time.Second):
		t.Fatal("a followed log did not end when the server left")
	}
	select {
	case <-terminal.Done():
		t.Fatalf("a handed-over terminal ended when the server left: %v", context.Cause(terminal))
	case <-time.After(200 * time.Millisecond):
	}
}

// Without the hand-over (no drain: the API role's default) a terminal ends at once, as before.
func TestATerminalNotHandedOverEndsWhenTheServerLeaves(t *testing.T) {
	p := probe.New()
	h := &Handler{leaving: p}
	terminal, release := h.holdTerminal(context.Background())
	defer release()
	p.Leave()
	select {
	case <-terminal.Done():
	case <-time.After(time.Second):
		t.Fatal("the terminal did not end when the server left")
	}
	if !probe.IsLeaving(terminal) {
		t.Fatalf("cause = %v", context.Cause(terminal))
	}
}
