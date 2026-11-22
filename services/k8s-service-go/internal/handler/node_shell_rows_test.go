package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nodeshells"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/probe"
)

// shellPodAPI is nodeShellAPI keeping the pod the handler made, the rows the store held when it came, and answering
// its create and delete as set.
type shellPodAPI struct {
	mu           sync.Mutex
	created      *corev1.Pod
	rowsAtCreate map[string]nodeshells.Row
	posts        atomic.Int32
	deletes      atomic.Int32
	deleteStatus int
	refuseCreate int  // a status the create is answered with, the pod not made
	cutCreate    bool // the pod is made, then the connection is cut before the answer
	store        *nodeshells.Memory
}

func (a *shellPodAPI) serve(w http.ResponseWriter, r *http.Request) {
	pods := "/api/v1/namespaces/" + nodeShellTestNamespace + "/pods"
	w.Header().Set("Content-Type", "application/json")
	pod := fmt.Sprintf(`{"apiVersion":"v1","kind":"Pod","metadata":{"name":"p","namespace":%q},"status":{"phase":"Pending"}}`, nodeShellTestNamespace)
	switch {
	case r.Method == http.MethodPost && r.URL.Path == pods:
		a.posts.Add(1)
		if a.refuseCreate != 0 {
			w.WriteHeader(a.refuseCreate)
			_, _ = fmt.Fprintf(w, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Forbidden","message":"pods is forbidden","code":%d}`, a.refuseCreate)
			return
		}
		body, _ := io.ReadAll(r.Body)
		obj, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, nil) // client-go may send protobuf
		p, ok := obj.(*corev1.Pod)
		if err != nil || !ok {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		a.mu.Lock()
		a.created = p
		if a.store != nil {
			a.rowsAtCreate = a.store.Rows()
		}
		a.mu.Unlock()
		if a.cutCreate {
			if hj, ok := w.(http.Hijacker); ok {
				if c, _, err := hj.Hijack(); err == nil {
					_ = c.Close()
				}
			}
			return
		}
		p.APIVersion, p.Kind = "v1", "Pod"
		out, _ := json.Marshal(p)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(out)
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, pods+"/"):
		a.deletes.Add(1)
		if a.deleteStatus != 0 {
			reason, message := "InternalError", "etcdserver: request timed out"
			if a.deleteStatus == http.StatusNotFound {
				reason, message = "NotFound", `pods "p" not found`
			}
			w.WriteHeader(a.deleteStatus)
			_, _ = fmt.Fprintf(w, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":%q,"message":%q,"code":%d}`, reason, message, a.deleteStatus)
			return
		}
		_, _ = w.Write([]byte(pod))
	case strings.HasPrefix(r.URL.Path, pods+"/"):
		_, _ = w.Write([]byte(pod))
	default:
		_, _ = fmt.Fprintf(w, `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":%q}}`, nodeShellTestNamespace)
	}
}

func (a *shellPodAPI) pod() *corev1.Pod {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.created
}

func newTracker(store *nodeshells.Memory) *nodeshells.Tracker {
	return nodeshells.NewTracker(store, func(context.Context, nodeshells.Row) (bool, error) { return false, nil }, nil, time.Hour)
}

// openTrackedShell opens a node shell on a handler whose node shells keep their rows with tracker and returns the
// socket and a function that closes it and waits for the handler to end.
func openTrackedShell(t *testing.T, api *shellPodAPI, tracker *nodeshells.Tracker) (*websocket.Conn, func()) {
	t.Helper()
	var version atomic.Int32
	h, _ := liveHandler(t, api.serve, &version)
	h.cfg = config.Config{NodeShellEnabled: true, NodeShellNamespace: nodeShellTestNamespace, NodeShellImages: []string{"example.test/shell:1"}, NodeShellTimeoutSec: 60}
	h.SetNodeShells(tracker)
	interval := nodeShellPollInterval
	nodeShellPollInterval = 5 * time.Millisecond
	t.Cleanup(func() { nodeShellPollInterval = interval })
	served := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(served)
		h.NodeDebugShellWS(w, withLogFileContext(r, "apps", "resource.node.shell"))
	}))
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	closeAndWait := func() { once.Do(func() { c.Close(); <-served }) }
	t.Cleanup(closeAndWait)
	return c, closeAndWait
}

// The node shell's row is written before its pod, the pod carries the row's id as a label and this server as its
// owner, and the row goes once the pod is deleted.
func TestANodeShellPodNamesItsRowAndItsServer(t *testing.T) {
	store := nodeshells.NewMemory(nil)
	tracker := newTracker(store)
	api := &shellPodAPI{store: store}
	c, closeShell := openTrackedShell(t, api, tracker)
	if s := readShellStatus(t, c); s.Status != shellWaiting {
		t.Fatalf("first status = %+v", s)
	}

	pod := api.pod()
	if pod == nil {
		t.Fatal("no pod made")
	}
	id := pod.Labels[nodeshells.LabelID]
	if id == "" || pod.Annotations[nodeshells.AnnotationOwner] != tracker.Owner() {
		t.Fatalf("pod labels %v annotations %v, want the row id and owner %q", pod.Labels, pod.Annotations, tracker.Owner())
	}
	if _, ok := api.rowsAtCreate[id]; !ok {
		t.Fatalf("no row %s when the pod was created (rows then: %v)", id, api.rowsAtCreate)
	}
	r, ok := store.Rows()[id]
	if !ok {
		t.Fatalf("no row %s in %v", id, store.Rows())
	}
	var person auth.TokenPayload
	_ = json.Unmarshal(r.Person, &person)
	var opened map[string]interface{}
	_ = json.Unmarshal(r.Audit, &opened)
	if r.Pod != pod.Name || r.Namespace != nodeShellTestNamespace || r.Cluster != "self" || r.Node != pod.Spec.NodeName ||
		r.Owner != tracker.Owner() || person.Email != "dev@example.com" || !person.HasPermissionForCluster("resource.node.shell", "self") ||
		opened["ActorEmail"] != "dev@example.com" {
		t.Fatalf("row %+v person %+v audit %v", r, person, opened)
	}

	closeShell()
	if api.deletes.Load() != 1 {
		t.Fatalf("pod deletes = %d, want 1", api.deletes.Load())
	}
	if _, ok := store.Rows()[id]; ok {
		t.Fatal("the row stays after the pod was deleted")
	}
}

// A pod the server could not delete keeps its row, marked released, which this server no longer beats: a sweep
// deletes the pod.
func TestANodeShellPodNotDeletedKeepsItsRow(t *testing.T) {
	store := nodeshells.NewMemory(nil)
	tracker := newTracker(store)
	api := &shellPodAPI{deleteStatus: http.StatusInternalServerError}
	c, closeShell := openTrackedShell(t, api, tracker)
	if s := readShellStatus(t, c); s.Status != shellWaiting {
		t.Fatalf("first status = %+v", s)
	}
	id := api.pod().Labels[nodeshells.LabelID]

	closeShell()
	if api.deletes.Load() == 0 {
		t.Fatal("no delete was sent")
	}
	if r, ok := store.Rows()[id]; !ok || r.Owner != tracker.Owner() || !r.Released {
		t.Fatalf("row = %+v %v, want it kept for a sweep, released", r, ok)
	}
}

// A row the database does not take refuses the shell before any pod is made.
func TestANodeShellWhoseRowIsNotSavedIsRefusedBeforeItsPod(t *testing.T) {
	store := nodeshells.NewMemory(nil)
	store.SetFail(errors.New("connection refused"))
	api := &shellPodAPI{store: store}
	c, _ := openTrackedShell(t, api, newTracker(store))
	if s := readShellStatus(t, c); s.Status != shellFailed || s.Message != "node shell row not saved" {
		t.Fatalf("first status = %+v, want failed: node shell row not saved", s)
	}
	if n := api.posts.Load(); n != 0 {
		t.Fatalf("pod creates = %d, want none", n)
	}
}

// A create the API server refused made no pod: the row goes at once and no delete is sent.
func TestARefusedCreateEndsTheRow(t *testing.T) {
	store := nodeshells.NewMemory(nil)
	api := &shellPodAPI{refuseCreate: http.StatusForbidden}
	c, _ := openTrackedShell(t, api, newTracker(store))
	if s := readShellStatus(t, c); s.Status != shellFailed {
		t.Fatalf("first status = %+v, want failed", s)
	}
	if len(store.Rows()) != 0 || api.deletes.Load() != 0 {
		t.Fatalf("rows %v, deletes %d; want no row and no delete", store.Rows(), api.deletes.Load())
	}
}

// A create whose answer was cut may have made the pod, or may make it after: the handler deletes it and ends the row
// when the delete went through; it leaves the row released to a sweep when the delete failed or found no pod yet.
func TestACreateCutBeforeItsAnswerDeletesThePodOrLeavesTheRow(t *testing.T) {
	for _, c := range []struct {
		name         string
		deleteStatus int
		rowLeft      bool
	}{{"deleted", 0, false}, {"not deleted", http.StatusInternalServerError, true}, {"not found yet", http.StatusNotFound, true}} {
		t.Run(c.name, func(t *testing.T) {
			store := nodeshells.NewMemory(nil)
			tracker := newTracker(store)
			api := &shellPodAPI{cutCreate: true, deleteStatus: c.deleteStatus}
			conn, _ := openTrackedShell(t, api, tracker)
			if s := readShellStatus(t, conn); s.Status != shellFailed {
				t.Fatalf("first status = %+v, want failed", s)
			}
			if api.deletes.Load() != 1 {
				t.Fatalf("deletes = %d, want 1", api.deletes.Load())
			}
			id := api.pod().Labels[nodeshells.LabelID]
			r, ok := store.Rows()[id]
			if ok != c.rowLeft || (ok && (!r.Released || r.Owner != tracker.Owner())) {
				t.Fatalf("row = %+v %v, want left %v (released)", r, ok, c.rowLeft)
			}
		})
	}
}

// A node shell stopped because its server could not save the heartbeat closes with its notice (1001, reason
// heartbeat_lost, en and ko) and leaves a k8s.session.end row with that reason; a pod exec terminal's end reads none.
func TestAHeartbeatNotSavedEndsTheNodeShellWithItsNoticeAndRow(t *testing.T) {
	held, stop := context.WithCancelCause(context.Background())
	stop(nodeshells.ErrHeartbeatLost)
	for lang, words := range map[string]string{"en": "could not write it to the database", "ko": "데이터베이스에 노드 셸을 적지 못해"} {
		notice, code, reason, ended := serverEnded(held, lang)
		if !ended || code != probe.ShutdownCloseCode || reason != nodeshells.ReasonHeartbeatLost || !strings.Contains(notice, words) {
			t.Fatalf("%s: serverEnded = %q %d %q %v", lang, notice, code, reason, ended)
		}
	}

	store := &lockedAudit{}
	h := &Handler{auditStore: store}
	ctx := cluster.WithID(auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Email: "u1@example.com"}), "c")
	r := httptest.NewRequest(http.MethodGet, "/api/v1/nodes/n1/debug-shell/ws", nil).WithContext(ctx)
	shellCtx, stopShell := context.WithCancelCause(ctx)
	stopShell(nodeshells.ErrHeartbeatLost)
	h.auditSessionEnd(shellCtx, r, "node", "n1", nodeShellTestNamespace, "node-shell")
	h.auditSessionEnd(shellCtx, r, "pod", "p", "ns", "exec")
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.rows) != 1 {
		t.Fatalf("rows %d, want the node shell's only", len(store.rows))
	}
	var after map[string]interface{}
	_ = json.Unmarshal(store.rows[0].After, &after)
	if store.rows[0].Action != auditSessionEndAction || store.rows[0].Result != audit.ResultSuccess || after["reason"] != nodeshells.ReasonHeartbeatLost || after["stream"] != "node-shell" {
		t.Fatalf("row %+v after %v", store.rows[0], after)
	}
}

// The chain from the tracker to the screen: a server whose heartbeat stops being saved stops its node shell within
// the self-stop time; the handler then tells the terminal why, closes it with 1001 and heartbeat_lost, deletes the pod
// and writes the attempt's failure row with that cause.
func TestATrackerThatCannotSaveTheHeartbeatClosesTheNodeShellAndDeletesItsPod(t *testing.T) {
	store := nodeshells.NewMemory(nil)
	tracker := newTracker(store).WithTimes(20*time.Millisecond, 120*time.Millisecond, time.Hour)
	runCtx, stopRun := context.WithCancel(context.Background())
	t.Cleanup(stopRun)
	go tracker.Run(runCtx)

	api := &shellPodAPI{}
	var version atomic.Int32
	h, audits := liveHandler(t, api.serve, &version)
	h.cfg = config.Config{NodeShellEnabled: true, NodeShellNamespace: nodeShellTestNamespace, NodeShellImages: []string{"example.test/shell:1"}, NodeShellTimeoutSec: 60}
	h.SetNodeShells(tracker)
	interval := nodeShellPollInterval
	nodeShellPollInterval = 5 * time.Millisecond
	t.Cleanup(func() { nodeShellPollInterval = interval })
	served := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(served)
		h.NodeDebugShellWS(w, withLogFileContext(r, "apps", "resource.node.shell"))
	}))
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"?lang=en", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(); <-served })
	if s := readShellStatus(t, c); s.Status != shellWaiting {
		t.Fatalf("first status = %+v", s)
	}

	store.SetFail(errors.New("dial tcp: i/o timeout")) // this server's database calls fail from here
	cutAt := time.Now()
	var text strings.Builder
	var closed *websocket.CloseError
	for closed == nil {
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, data, err := c.ReadMessage()
		if err != nil {
			if !errors.As(err, &closed) {
				t.Fatalf("read: %v (text so far %q)", err, text.String())
			}
			break
		}
		text.Write(data)
	}
	if closed.Code != probe.ShutdownCloseCode || closed.Text != nodeshells.ReasonHeartbeatLost {
		t.Fatalf("closed %d %q, want 1001 heartbeat_lost", closed.Code, closed.Text)
	}
	if !strings.Contains(text.String(), "could not write it to the database") {
		t.Fatalf("the terminal read %q, want the notice", text.String())
	}
	if since := time.Since(cutAt); since > 2*time.Second {
		t.Fatalf("closed %s after the heartbeat stopped being saved", since)
	}
	deadline := time.Now().Add(3 * time.Second)
	for api.deletes.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if api.deletes.Load() != 1 {
		t.Fatalf("pod deletes = %d, want 1", api.deletes.Load())
	}
	row := audits.shellRow(t)
	if row.Result != audit.ResultFailure || !strings.Contains(row.Error, nodeshells.ErrHeartbeatLost.Error()) {
		t.Fatalf("k8s.node.shell row %+v, want a failure naming the heartbeat", row)
	}
}
