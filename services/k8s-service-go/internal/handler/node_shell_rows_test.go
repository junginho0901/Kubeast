package handler

import (
	"context"
	"encoding/json"
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
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// shellPodAPI is nodeShellAPI keeping the pod the handler made and answering its delete with deleteStatus.
type shellPodAPI struct {
	mu           sync.Mutex
	created      *corev1.Pod
	deletes      atomic.Int32
	deleteStatus int
}

func (a *shellPodAPI) serve(w http.ResponseWriter, r *http.Request) {
	pods := "/api/v1/namespaces/" + nodeShellTestNamespace + "/pods"
	w.Header().Set("Content-Type", "application/json")
	pod := fmt.Sprintf(`{"apiVersion":"v1","kind":"Pod","metadata":{"name":"p","namespace":%q},"status":{"phase":"Pending"}}`, nodeShellTestNamespace)
	switch {
	case r.Method == http.MethodPost && r.URL.Path == pods:
		body, _ := io.ReadAll(r.Body)
		obj, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, nil) // client-go may send protobuf
		p, ok := obj.(*corev1.Pod)
		if err != nil || !ok {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		a.mu.Lock()
		a.created = p
		a.mu.Unlock()
		p.APIVersion, p.Kind = "v1", "Pod"
		out, _ := json.Marshal(p)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(out)
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, pods+"/"):
		a.deletes.Add(1)
		if a.deleteStatus != 0 {
			w.WriteHeader(a.deleteStatus)
			_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"Status","status":"Failure","message":"etcdserver: request timed out","code":500}`))
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

// openTrackedShell opens a node shell on a handler whose node shells keep their rows in store, waits for the pod, and
// returns the socket and a function that closes it and waits for the handler to end.
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
	if s := readShellStatus(t, c); s.Status != shellWaiting {
		t.Fatalf("first status = %+v", s)
	}
	return c, closeAndWait
}

// The node shell's row is written before its pod, the pod carries the row's id as a label and this server as its
// owner, and the row goes once the pod is deleted.
func TestANodeShellPodNamesItsRowAndItsServer(t *testing.T) {
	store := nodeshells.NewMemory(nil)
	tracker := nodeshells.NewTracker(store, func(context.Context, nodeshells.Row) (bool, error) { return false, nil }, nil)
	api := &shellPodAPI{}
	_, closeShell := openTrackedShell(t, api, tracker)

	pod := api.pod()
	if pod == nil {
		t.Fatal("no pod made")
	}
	id := pod.Labels[nodeshells.LabelID]
	if id == "" || pod.Annotations[nodeshells.AnnotationOwner] != tracker.Owner() {
		t.Fatalf("pod labels %v annotations %v, want the row id and owner %q", pod.Labels, pod.Annotations, tracker.Owner())
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

// A pod the server could not delete keeps its row, which this server no longer beats: a sweep deletes the pod.
func TestANodeShellPodNotDeletedKeepsItsRow(t *testing.T) {
	store := nodeshells.NewMemory(nil)
	tracker := nodeshells.NewTracker(store, func(context.Context, nodeshells.Row) (bool, error) { return false, nil }, nil)
	api := &shellPodAPI{deleteStatus: http.StatusInternalServerError}
	_, closeShell := openTrackedShell(t, api, tracker)
	id := api.pod().Labels[nodeshells.LabelID]

	closeShell()
	if api.deletes.Load() == 0 {
		t.Fatal("no delete was sent")
	}
	if r, ok := store.Rows()[id]; !ok || r.Owner != tracker.Owner() {
		t.Fatalf("row = %+v %v, want it kept for a sweep", r, ok)
	}
}
