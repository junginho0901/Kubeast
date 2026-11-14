package ws

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/pkg/probe"
)

// The server leaving (SIGTERM) closes an open socket with 1001 and server_shutdown, which the screen reads as "connect again", ends its
// watches on the API server and releases its hold, so shutdown does not wait for it.
func TestAnOpenSocketClosesWithServiceRestartWhenTheServerLeaves(t *testing.T) {
	var watchEnded atomic.Bool
	m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
		eventThenHold(w, r)
		watchEnded.Store(true)
	})
	m.Leaving = probe.New()
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("first frame = %+v", f)
	}

	m.Leaving.Leave()

	_, _, err := conn.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != probe.ShutdownCloseCode || closed.Text != probe.ShutdownReason {
		t.Fatalf("read after the server left = %v, want close %d %q", err, probe.ShutdownCloseCode, probe.ShutdownReason)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if !m.Leaving.Wait(ctx) {
		t.Fatalf("the socket still holds the server after its close (held %d)", m.Leaving.Held())
	}
	deadline := time.Now().Add(3 * time.Second)
	for !watchEnded.Load() {
		if time.Now().After(deadline) {
			t.Fatal("the watch on the API server kept running after the socket closed")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
