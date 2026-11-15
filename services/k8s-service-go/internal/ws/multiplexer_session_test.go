package ws

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// liveSessionsAt checks every few milliseconds against a version the test moves.
func liveSessionsAt(version *atomic.Int32) *auth.LiveSessions {
	return auth.NewLiveSessions(auth.LiveSessionConfig{
		Lookup: func(context.Context, string, string) (auth.SessionState, error) {
			return auth.SessionState{Version: int(version.Load())}, nil
		},
		CheckEvery: 5 * time.Millisecond, CacheTTL: time.Millisecond,
	})
}

func TestAnOpenSocketClosesWithTheReasonWhenItsSessionIsRevoked(t *testing.T) {
	var watchEnded atomic.Bool
	m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
		eventThenHold(w, r)
		watchEnded.Store(true)
	})
	var version atomic.Int32
	m.Sessions = liveSessionsAt(&version)
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("first frame = %+v", f)
	}

	version.Store(1)

	_, _, err := conn.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != auth.SessionEndedCloseCode || closed.Text != auth.SessionRevoked {
		t.Fatalf("read after revocation = %v, want close %d %q", err, auth.SessionEndedCloseCode, auth.SessionRevoked)
	}
	deadline := time.Now().Add(3 * time.Second)
	for !watchEnded.Load() {
		if time.Now().After(deadline) {
			t.Fatal("the watch on the API server kept running after the socket closed")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestAnOpenSocketPastItsTokenStaysWhileItsSessionStands(t *testing.T) {
	m := muxOn(t, eventThenHold)
	var version atomic.Int32
	m.Sessions = liveSessionsAt(&version)
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("first frame = %+v", f)
	}
	time.Sleep(100 * time.Millisecond)
	// The same socket still takes a new watch and answers it.
	request(t, conn, "REQUEST", "c1", "/api/v1/namespaces/demo/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("frame after the checks = %+v", f)
	}
}
