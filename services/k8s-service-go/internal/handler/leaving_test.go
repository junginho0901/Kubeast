package handler

import (
	"bytes"
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/pkg/probe"
)

// A terminal whose server leaves (SIGTERM) says so, closes with 1012 and hangs its shell up, as the browser going away
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
	if !errors.As(err, &closed) || closed.Code != websocket.CloseServiceRestart || closed.Text != probe.LeavingReason {
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
	if got := serverLeavingNotice("ko-KR"); !strings.Contains(got, "서버가 다시 시작되어") {
		t.Fatalf("ko notice = %q", got)
	}
	if got := serverLeavingNotice(""); !strings.Contains(got, "Open the terminal again") {
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
