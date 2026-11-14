package handler

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// withKeepalive shortens the keepalive period and the wait for a pong for one test.
func withKeepalive(t *testing.T, period, pongWait time.Duration) {
	t.Helper()
	p, w := keepalivePeriod, terminalPongWait
	keepalivePeriod, terminalPongWait = period, pongWait
	t.Cleanup(func() { keepalivePeriod, terminalPongWait = p, w })
}

func useExecutor(t *testing.T, e remotecommand.Executor) {
	t.Helper()
	orig := newShellExecutor
	newShellExecutor = func(*rest.Config, *url.URL) (remotecommand.Executor, error) { return e, nil }
	t.Cleanup(func() { newShellExecutor = orig })
}

// browserSocket reads a terminal socket as a browser does: it answers each ping with a pong and keeps the data frames.
type browserSocket struct {
	conn   *websocket.Conn
	pings  atomic.Int32
	frames chan []byte
}

func browse(t *testing.T, target string) *browserSocket {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(target, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	b := &browserSocket{conn: c, frames: make(chan []byte, 256)}
	c.SetPingHandler(func(m string) error {
		b.pings.Add(1)
		return c.WriteControl(websocket.PongMessage, []byte(m), time.Now().Add(time.Second))
	})
	go func() {
		defer close(b.frames)
		for {
			_, data, err := c.ReadMessage()
			if err != nil {
				return
			}
			b.frames <- data
		}
	}()
	return b
}

// frame is the next data frame: its channel and text.
func (b *browserSocket) frame(t *testing.T) (byte, string) {
	t.Helper()
	select {
	case data, ok := <-b.frames:
		if !ok || len(data) == 0 {
			t.Fatal("the socket closed")
		}
		return data[0], string(data[1:])
	case <-time.After(5 * time.Second):
		t.Fatal("no frame")
	}
	return 0, ""
}

// A terminal nobody types into still carries pings, so nginx and a load balancer in front (60 s idle) do not cut it,
// and the browser's pongs keep it open past the wait for one.
func TestAQuietTerminalIsPingedAndStaysOpen(t *testing.T) {
	withKeepalive(t, 20*time.Millisecond, 300*time.Millisecond)
	var version atomic.Int32
	h, _ := liveHandler(t, func(http.ResponseWriter, *http.Request) {}, &version)
	useExecutor(t, &fakeExecutor{endOnEOT: true})
	served := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(served)
		h.PodExecWS(w, withLogFileContext(r, "apps", "resource.pod.exec"))
	}))
	defer srv.Close()
	b := browse(t, srv.URL+"?container=app")
	// srv.Close does not wait for a hijacked socket's handler: close the socket and wait, before withKeepalive's cleanup.
	t.Cleanup(func() { b.conn.Close(); <-served })
	b.frame(t) // ready
	b.frame(t) // prompt

	time.Sleep(700 * time.Millisecond)

	if got := b.pings.Load(); got < 10 {
		t.Fatalf("pings while quiet = %d, want at least 10", got)
	}
	if n := len(b.frames); n != 0 {
		t.Fatalf("%d data frames while quiet, want none: a ping is no terminal output, and only output is recorded", n)
	}
	if err := b.conn.WriteMessage(websocket.TextMessage, []byte("ls")); err != nil {
		t.Fatal(err)
	}
	if ch, s := b.frame(t); ch != shellStdout || s != "echo:ls" {
		t.Fatalf("after the quiet time: frame %d %q, want the shell's echo", ch, s)
	}
}

// The node shell's wait for its debug pod (up to 90 s) carries pings too.
func TestANodeShellWaitingForItsPodIsPinged(t *testing.T) {
	withKeepalive(t, 20*time.Millisecond, 300*time.Millisecond)
	var version, deleted atomic.Int32
	c, _ := openNodeShell(t, "Pending", &version, &deleted)
	if s := readShellStatus(t, c); s.Status != shellWaiting {
		t.Fatalf("first status = %+v", s)
	}
	var pings atomic.Int32
	c.SetPingHandler(func(m string) error {
		pings.Add(1)
		return c.WriteControl(websocket.PongMessage, []byte(m), time.Now().Add(time.Second))
	})
	// pings are answered while the client reads; the debug pod stays Pending
	_ = c.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			break
		}
	}
	if got := pings.Load(); got < 5 {
		t.Fatalf("pings while the debug pod starts = %d, want at least 5", got)
	}
}

// A browser that is gone without closing answers no ping: the shell is hung up as for a closed tab, not left
// running in the container.
func TestATerminalWhoseBrowserStopsAnsweringIsHungUp(t *testing.T) {
	withKeepalive(t, 20*time.Millisecond, 200*time.Millisecond)
	withHangupGrace(t, 2*time.Second)
	fake := &fakeExecutor{endOnEOT: true}
	c, done := bridge(t, fake)
	readFrame(t, c) // ready
	readFrame(t, c) // prompt
	// From here the client reads nothing, so it answers no ping.
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("streamShell = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the shell of a browser that stopped answering was left running")
	}
	if got := fake.gotStdin(); !bytes.HasSuffix(got, []byte("\x03\x04")) {
		t.Fatalf("stdin = %q, want the hang-up keys", got)
	}
}

// The pings of a terminal end with its connection or its context, whichever goes first.
func TestTerminalPingsStopWithTheConnectionOrTheContext(t *testing.T) {
	withKeepalive(t, 10*time.Millisecond, time.Second)
	for _, end := range []string{"connection", "context"} {
		t.Run(end, func(t *testing.T) {
			stopped := make(chan struct{})
			endNow := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				go func() {
					pingTerminal(ctx, conn, nil)
					close(stopped)
				}()
				<-endNow
				if end == "connection" {
					_ = conn.Close()
				} else {
					cancel()
				}
				<-stopped
			}))
			defer srv.Close()
			b := browse(t, srv.URL)
			time.Sleep(150 * time.Millisecond)
			if got := b.pings.Load(); got < 3 {
				t.Fatalf("pings before the end = %d, want at least 3", got)
			}
			close(endNow)
			select {
			case <-stopped:
			case <-time.After(2 * time.Second):
				t.Fatalf("pings went on after the %s ended", end)
			}
			time.Sleep(30 * time.Millisecond) // a ping written just before the end may still be on its way
			at := b.pings.Load()
			time.Sleep(60 * time.Millisecond)
			if got := b.pings.Load(); got != at {
				t.Fatalf("pings after the end = %d, want %d", got, at)
			}
		})
	}
}

// quietLogAPI answers a pod's log with lines and then nothing until the caller goes.
func quietLogAPI(lines ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/log") {
			http.NotFound(w, r)
			return
		}
		for _, l := range lines {
			_, _ = fmt.Fprintln(w, l)
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}
}

// rawLines reads an event stream line by line, comment lines included, for d.
func rawLines(t *testing.T, serve http.HandlerFunc, target string, d time.Duration) []string {
	t.Helper()
	srv := httptest.NewServer(serve)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+target, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []string
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		out = append(out, sc.Text())
	}
	return out
}

// A followed log of a pod that prints nothing says it is alive with a comment line, which EventSource ignores; the
// comment is no log line.
func TestAQuietFollowedLogSaysItIsAlive(t *testing.T) {
	withKeepalive(t, 20*time.Millisecond, time.Second)
	var version atomic.Int32
	h, _ := liveHandler(t, quietLogAPI("2026-11-09T05:58:05.100000000Z one"), &version)
	got := rawLines(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodLogsSSE(w, withLogFileContext(r, "apps", "resource.pod.read"))
	}, "/x?container=app", 400*time.Millisecond)
	keepalives, data := 0, []string{}
	for _, l := range got {
		switch {
		case l == ": keepalive":
			keepalives++
		case strings.HasPrefix(l, "data: "):
			data = append(data, strings.TrimPrefix(l, "data: "))
		}
	}
	if keepalives < 5 {
		t.Fatalf("keepalive comments in 400 ms of quiet = %d, want at least 5 (lines %q)", keepalives, got)
	}
	if want := []string{"2026-11-09T05:58:05.100000000Z one"}; !slices.Equal(data, want) {
		t.Fatalf("data = %q, want %q", data, want)
	}
}

// A log that keeps printing needs no keepalive: the comment is written only after a quiet period.
func TestAFlowingFollowedLogHasNoKeepalive(t *testing.T) {
	withKeepalive(t, 100*time.Millisecond, time.Second)
	var ended atomic.Bool
	var version atomic.Int32
	h, _ := liveHandler(t, logAPI(&ended), &version)
	got := rawLines(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodLogsSSE(w, withLogFileContext(r, "apps", "resource.pod.read"))
	}, "/x?container=app", 400*time.Millisecond)
	lines := 0
	for _, l := range got {
		if l == ": keepalive" {
			t.Fatalf("a keepalive among flowing lines: %q", got)
		}
		if strings.HasPrefix(l, "data: ") {
			lines++
		}
	}
	if lines < 20 {
		t.Fatalf("lines in 400 ms = %d, want the log flowing", lines)
	}
}
