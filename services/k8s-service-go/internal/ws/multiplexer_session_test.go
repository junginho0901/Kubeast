package ws

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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

// One ticker checks every socket's session (auth.LiveSessions' sweep): a socket whose session ends closes within the
// check interval with the reason, and a socket of another session beside it stays.
func TestASocketWhoseSessionEndsClosesWithinTheCheckInterval(t *testing.T) {
	const every = 300 * time.Millisecond
	m := muxOn(t, eventThenHold)
	var revoked atomic.Int32
	m.Sessions = auth.NewLiveSessions(auth.LiveSessionConfig{
		Lookup: func(_ context.Context, userID, _ string) (int, error) {
			if userID == "ended" {
				return int(revoked.Load()), nil
			}
			return 0, nil
		},
		CheckEvery: every, CacheTTL: time.Millisecond,
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := auth.TokenPayload{UserID: r.URL.Query().Get("u"), Perms: everyCluster}
		m.HandleWebSocket(w, r.WithContext(auth.WithPayload(r.Context(), p)))
	}))
	t.Cleanup(server.Close)
	dial := func(user string) *websocket.Conn {
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"?u="+user, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
		if f := nextFrame(t, conn); f.Type != "DATA" {
			t.Fatalf("%s: first frame = %+v", user, f)
		}
		return conn
	}
	ended, stays := dial("ended"), dial("stays")

	time.Sleep(every / 3)
	revoked.Store(1)
	at := time.Now()
	_ = ended.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err := ended.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != auth.SessionEndedCloseCode || closed.Text != auth.SessionRevoked {
		t.Fatalf("read after the session ended = %v, want close %d %q", err, auth.SessionEndedCloseCode, auth.SessionRevoked)
	}
	if took := time.Since(at); took > every+every/2 {
		t.Errorf("the socket closed %s after its session ended, want within the check interval of %s", took, every)
	}

	time.Sleep(2 * every)
	request(t, stays, "REQUEST", "c1", "/api/v1/namespaces/demo/pods", "watch=1")
	if f := nextFrame(t, stays); f.Type != "DATA" {
		t.Fatalf("the other socket after the checks: %+v", f)
	}
}
