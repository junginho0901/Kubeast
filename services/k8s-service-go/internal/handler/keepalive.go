package handler

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// keepalivePeriod keeps a quiet terminal or event stream under the 60 s idle cut of nginx and load balancers, as ws.pingPeriod does.
var keepalivePeriod = 25 * time.Second

// terminalPongWait is how long a terminal waits for a key or a pong before it counts the browser gone.
var terminalPongWait = 60 * time.Second

const terminalWriteWait = 10 * time.Second

// pingTerminal pings until ctx ends, stop closes or a ping fails; a ping is no output, so a recording never holds one.
func pingTerminal(ctx context.Context, conn *websocket.Conn, stop <-chan struct{}) {
	ticker := time.NewTicker(keepalivePeriod)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stop:
			return
		case <-ticker.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(terminalWriteWait)); err != nil {
				return
			}
		}
	}
}

// sseKeepaliveLine is a comment line: EventSource and the console's stream readers skip it.
const sseKeepaliveLine = ": keepalive\n\n"

// sseKeepalive writes sseKeepaliveLine between events after keepalivePeriod of quiet, serialised with the stream's writes.
type sseKeepalive struct {
	w http.ResponseWriter
	f http.Flusher

	mu      sync.Mutex
	last    time.Time
	between bool // the last write ended an event

	done     chan struct{}
	finished chan struct{}
}

func startSSEKeepalive(w http.ResponseWriter, f http.Flusher) *sseKeepalive {
	k := &sseKeepalive{w: w, f: f, last: time.Now(), between: true, done: make(chan struct{}), finished: make(chan struct{})}
	go k.run(keepalivePeriod)
	return k
}

func (k *sseKeepalive) run(period time.Duration) {
	defer close(k.finished)
	timer := time.NewTimer(period)
	defer timer.Stop()
	for {
		select {
		case <-k.done:
			return
		case <-timer.C:
		}
		k.mu.Lock()
		wait := period - time.Since(k.last)
		if wait <= 0 {
			wait = period
			if k.between {
				if _, err := io.WriteString(k.w, sseKeepaliveLine); err != nil {
					k.mu.Unlock()
					return
				}
				k.f.Flush()
				k.last = time.Now()
			}
		}
		k.mu.Unlock()
		timer.Reset(wait)
	}
}

func (k *sseKeepalive) Header() http.Header { return k.w.Header() }

func (k *sseKeepalive) WriteHeader(code int) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.w.WriteHeader(code)
}

func (k *sseKeepalive) Write(p []byte) (int, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	n, err := k.w.Write(p)
	if n > 0 {
		k.last = time.Now()
		k.between = bytes.HasSuffix(p[:n], []byte("\n\n"))
	}
	return n, err
}

func (k *sseKeepalive) Flush() {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.f.Flush()
}

func (k *sseKeepalive) stop() {
	close(k.done)
	<-k.finished
}
