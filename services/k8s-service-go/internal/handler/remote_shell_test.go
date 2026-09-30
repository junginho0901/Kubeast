package handler

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
	utilexec "k8s.io/client-go/util/exec"
)

func TestExecAndAttachURL(t *testing.T) {
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: "https://k8s.example:6443"})
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}
	u := execURL(cs, "team-a", "web-0", "app", "/bin/sh")
	if u.Host != "k8s.example:6443" || u.Path != "/api/v1/namespaces/team-a/pods/web-0/exec" {
		t.Fatalf("exec url = %s", u)
	}
	q := u.Query()
	for k, want := range map[string]string{"command": "/bin/sh", "container": "app", "stdin": "true", "stdout": "true", "stderr": "true", "tty": "true"} {
		if got := q.Get(k); got != want {
			t.Errorf("exec %s = %q, want %q", k, got, want)
		}
	}
	a := attachURL(cs, "kubeast-node-shell", "node-debugger-x", "debugger")
	if a.Path != "/api/v1/namespaces/kubeast-node-shell/pods/node-debugger-x/attach" || a.Query().Get("container") != "debugger" || a.Query().Get("tty") != "true" {
		t.Fatalf("attach url = %s", a)
	}
}

// fakeExecutor stands in for the API server stream: it says "ready" on
// stderr, echoes stdin to stdout, and ends with result — after the first
// input when endAfterPrompt is set (the process ended on its own), otherwise
// when stdin closes (the browser went away).
type fakeExecutor struct {
	result         error
	endAfterPrompt bool
	gotCfg         *rest.Config
}

func (f *fakeExecutor) Stream(remotecommand.StreamOptions) error { return errors.New("unused") }

func (f *fakeExecutor) StreamWithContext(ctx context.Context, o remotecommand.StreamOptions) error {
	if !o.Tty || o.Stdin == nil || o.Stdout == nil || o.Stderr == nil {
		return errors.New("stream options: want tty + all three streams")
	}
	_, _ = o.Stderr.Write([]byte("ready"))
	buf := make([]byte, 64)
	for {
		n, err := o.Stdin.Read(buf)
		if n > 0 {
			_, _ = o.Stdout.Write(append([]byte("echo:"), buf[:n]...))
			if f.endAfterPrompt {
				return f.result
			}
		}
		if err != nil {
			return f.result
		}
	}
}

// bridge runs streamShell behind a test WebSocket server and returns a client
// connection plus a channel that yields streamShell's return value.
func bridge(t *testing.T, fake *fakeExecutor) (*websocket.Conn, <-chan error) {
	t.Helper()
	orig := newShellExecutor
	newShellExecutor = func(cfg *rest.Config, u *url.URL) (remotecommand.Executor, error) {
		fake.gotCfg = cfg
		return fake, nil
	}
	t.Cleanup(func() { newShellExecutor = orig })

	done := make(chan error, 1)
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		done <- streamShell(r.Context(), conn, &rest.Config{Host: "https://k8s.example:6443", Impersonate: rest.ImpersonationConfig{UserName: "u@example.com"}}, &url.URL{Path: "/x"})
	}))
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	return c, done
}

func readFrame(t *testing.T, c *websocket.Conn) (byte, string) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, data, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.BinaryMessage || len(data) == 0 {
		t.Fatalf("frame type %d len %d", mt, len(data))
	}
	return data[0], string(data[1:])
}

func TestStreamShell_BridgesFramesAndIdentity(t *testing.T) {
	fake := &fakeExecutor{}
	c, done := bridge(t, fake)

	if ch, s := readFrame(t, c); ch != shellStderr || s != "ready" {
		t.Fatalf("first frame = %d %q, want stderr ready", ch, s)
	}
	// The bridge sends a first Enter so the prompt appears.
	if ch, s := readFrame(t, c); ch != shellStdout || s != "echo:\r" {
		t.Fatalf("prompt frame = %d %q", ch, s)
	}
	if err := c.WriteMessage(websocket.TextMessage, []byte("ls\r")); err != nil {
		t.Fatal(err)
	}
	if ch, s := readFrame(t, c); ch != shellStdout || s != "echo:ls\r" {
		t.Fatalf("echo frame = %d %q", ch, s)
	}
	if fake.gotCfg == nil || fake.gotCfg.Impersonate.UserName != "u@example.com" {
		t.Fatalf("executor did not get the identity config: %+v", fake.gotCfg)
	}
	// Browser goes away: stdin ends, the stream ends, streamShell returns nil.
	c.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("streamShell: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("streamShell did not return after the browser closed")
	}
}

func TestStreamShell_ExitStatusOnErrorChannel(t *testing.T) {
	fake := &fakeExecutor{result: utilexec.CodeExitError{Err: errors.New("command terminated with exit code 2"), Code: 2}, endAfterPrompt: true}
	c, done := bridge(t, fake)
	readFrame(t, c) // ready
	readFrame(t, c) // prompt echo
	ch, s := readFrame(t, c)
	if ch != shellError || !strings.Contains(s, "exit code 2") {
		t.Fatalf("exit frame = %d %q", ch, s)
	}
	if err := <-done; err != nil {
		t.Fatalf("a non-zero exit is not a bridge error, got %v", err)
	}
}

func TestStreamShell_TransportErrorReturned(t *testing.T) {
	fake := &fakeExecutor{result: io.ErrUnexpectedEOF, endAfterPrompt: true}
	c, done := bridge(t, fake)
	readFrame(t, c)
	readFrame(t, c)
	if err := <-done; !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("got %v, want the executor error", err)
	}
}
