package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

const nodeShellTestNamespace = "kubeast-node-shell"

// nodeShellAPI is the API server of a node shell: its namespace is there, the debug pod reads as phase, and the pod's
// delete is counted.
func nodeShellAPI(phase string, deleted *atomic.Int32) http.HandlerFunc {
	pods := "/api/v1/namespaces/" + nodeShellTestNamespace + "/pods"
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		pod := fmt.Sprintf(`{"apiVersion":"v1","kind":"Pod","metadata":{"name":"p","namespace":%q},"status":{"phase":%q}}`, nodeShellTestNamespace, phase)
		switch {
		case r.Method == http.MethodPost && r.URL.Path == pods:
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(pod))
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, pods+"/"):
			deleted.Add(1)
			_, _ = w.Write([]byte(pod))
		case strings.HasPrefix(r.URL.Path, pods+"/"):
			_, _ = w.Write([]byte(pod))
		default:
			_, _ = fmt.Fprintf(w, `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":%q}}`, nodeShellTestNamespace)
		}
	}
}

// openNodeShell opens the handler's socket against nodeShellAPI, as a user holding resource.node.shell.
func openNodeShell(t *testing.T, phase string, version, deleted *atomic.Int32) (*websocket.Conn, *lockedAudit) {
	t.Helper()
	h, store := liveHandler(t, nodeShellAPI(phase, deleted), version)
	h.cfg = config.Config{NodeShellEnabled: true, NodeShellNamespace: nodeShellTestNamespace, NodeShellImages: []string{"example.test/shell:1"}, NodeShellTimeoutSec: 60}
	interval := nodeShellPollInterval
	nodeShellPollInterval = 5 * time.Millisecond
	t.Cleanup(func() { nodeShellPollInterval = interval })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.NodeDebugShellWS(w, withLogFileContext(r, "apps", "resource.node.shell"))
	}))
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c, store
}

// readShellStatus reads the terminal's next text frame as a status.
func readShellStatus(t *testing.T, c *websocket.Conn) shellStatus {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	var s shellStatus
	if err := json.Unmarshal(data, &s); err != nil || s.Type != "status" {
		t.Fatalf("frame %q is not a status: %v", data, err)
	}
	return s
}

func wantSessionEndedClose(t *testing.T, c *websocket.Conn) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err := c.ReadMessage()
	var closed *websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != auth.SessionEndedCloseCode || closed.Text != auth.SessionRevoked {
		t.Fatalf("after the notice: %v", err)
	}
}

func wantDebugPodDeleted(t *testing.T, deleted *atomic.Int32) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for deleted.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := deleted.Load(); got != 1 {
		t.Fatalf("debug pod deletes = %d, want 1", got)
	}
}

// shellRow waits for the k8s.node.shell row the attempt leaves.
func (a *lockedAudit) shellRow(t *testing.T) audit.Record {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		for _, r := range a.rows {
			if r.Action == "k8s.node.shell" {
				a.mu.Unlock()
				return r
			}
		}
		a.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no k8s.node.shell row")
	return audit.Record{}
}

// A session that stops standing while the debug pod starts tells the terminal why and takes the pod away.
func TestANodeShellWaitingForItsPodEndsWithItsSession(t *testing.T) {
	var version, deleted atomic.Int32
	c, store := openNodeShell(t, "Pending", &version, &deleted)
	if s := readShellStatus(t, c); s.Status != shellWaiting {
		t.Fatalf("first status = %+v", s)
	}

	version.Store(1)

	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, data, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read notice: %v", err)
	}
	if mt != websocket.TextMessage || !strings.Contains(string(data), "your account or access changed") {
		t.Fatalf("notice frame = %d %q", mt, data)
	}
	wantSessionEndedClose(t, c)
	wantDebugPodDeleted(t, &deleted)
	row := store.shellRow(t)
	if row.Result != audit.ResultFailure {
		t.Fatalf("the attempt's row = %+v, want a failure: no shell opened", row)
	}
	if want := "session ended: " + auth.SessionRevoked; row.Error != want {
		t.Fatalf("the attempt's row says %q, want %q", row.Error, want)
	}
}

// A session that stops standing with the shell open hangs up the shell, leaves the session's row and takes the pod away.
func TestAnOpenNodeShellEndsWithItsSession(t *testing.T) {
	var version, deleted atomic.Int32
	fake := &fakeExecutor{endOnEOT: true}
	orig := newShellExecutor
	newShellExecutor = func(*rest.Config, *url.URL) (remotecommand.Executor, error) { return fake, nil }
	t.Cleanup(func() { newShellExecutor = orig })
	c, store := openNodeShell(t, "Running", &version, &deleted)
	if s := readShellStatus(t, c); s.Status != shellWaiting {
		t.Fatalf("first status = %+v", s)
	}
	if s := readShellStatus(t, c); s.Status != shellStarting {
		t.Fatalf("second status = %+v", s)
	}
	readFrame(t, c) // ready
	readFrame(t, c) // prompt

	version.Store(1)

	if ch, s := readFrame(t, c); ch != shellStderr || !strings.Contains(s, "your account or access changed") {
		t.Fatalf("notice frame = %d %q", ch, s)
	}
	wantSessionEndedClose(t, c)
	if row := store.sessionEndRow(t); row["stream"] != "node-shell" || row["reason"] != auth.SessionRevoked {
		t.Fatalf("session end row = %v", row)
	}
	wantDebugPodDeleted(t, &deleted)
	if row := store.shellRow(t); row.Result == audit.ResultFailure {
		t.Fatalf("the attempt's row = %+v, want a success: the shell opened", row)
	}
}
