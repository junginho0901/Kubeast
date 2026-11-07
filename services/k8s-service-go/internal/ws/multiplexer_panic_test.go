package ws

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
)

const (
	deploymentsPath = "/apis/apps/v1/namespaces/demo/deployments"
	podsPath        = "/api/v1/namespaces/demo/pods"
	namespacesPath  = "/api/v1/namespaces"
	panicText       = "fake-secret-value"
)

// panicsWhenEncoded is what no API server sends and stands for an object this service has a bug about: converting or
// encoding it panics with text the log must not hold.
type panicsWhenEncoded struct{}

func (panicsWhenEncoded) MarshalJSON() ([]byte, error) { panic(panicText) }

func objectOf(kind, name, version string, extra map[string]interface{}) *unstructured.Unstructured {
	metadata := map[string]interface{}{"name": name, "namespace": "demo", "resourceVersion": version}
	for k, v := range extra {
		metadata[k] = v
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{"apiVersion": "v1", "kind": kind, "metadata": metadata}}
}

// A Deployment's row converts its creation time, which reads the value through its JSON.
func deploymentRowPanics(version string) *unstructured.Unstructured {
	return objectOf("Deployment", "boom", version, map[string]interface{}{"creationTimestamp": panicsWhenEncoded{}})
}

// A Namespace's row carries its labels as they came, so this one reaches the writer whole.
func namespaceFramePanics() *unstructured.Unstructured {
	return objectOf("Namespace", "boom", "9", map[string]interface{}{"labels": panicsWhenEncoded{}})
}

// scriptedWatches answers each watch of a resource with what the test gives it, and keeps what each was asked.
type scriptedWatches struct {
	dynamic.Interface
	mu     sync.Mutex
	answer func(resource string, try int, w *watch.FakeWatcher)
	tries  map[string][]watchTry
	open   map[string][]*watch.FakeWatcher
}

type watchTry struct {
	at      time.Time
	version string
}

func newScriptedWatches(answer func(resource string, try int, w *watch.FakeWatcher)) *scriptedWatches {
	return &scriptedWatches{answer: answer, tries: map[string][]watchTry{}, open: map[string][]*watch.FakeWatcher{}}
}

func (s *scriptedWatches) Resource(gvr schema.GroupVersionResource) dynamic.NamespaceableResourceInterface {
	return scriptedResource{s: s, resource: gvr.Resource}
}

type scriptedResource struct {
	dynamic.NamespaceableResourceInterface
	s        *scriptedWatches
	resource string
}

func (r scriptedResource) Namespace(string) dynamic.ResourceInterface { return r }

func (r scriptedResource) Watch(_ context.Context, opts metav1.ListOptions) (watch.Interface, error) {
	w := watch.NewFakeWithChanSize(8, false)
	r.s.mu.Lock()
	defer r.s.mu.Unlock()
	r.s.tries[r.resource] = append(r.s.tries[r.resource], watchTry{at: time.Now(), version: opts.ResourceVersion})
	r.s.open[r.resource] = append(r.s.open[r.resource], w)
	r.s.answer(r.resource, len(r.s.tries[r.resource]), w)
	return w, nil
}

func (s *scriptedWatches) triesOf(resource string) []watchTry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]watchTry(nil), s.tries[resource]...)
}

// tell sends a change to every open watch of a resource.
func (s *scriptedWatches) tell(resource string, obj *unstructured.Unstructured) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, w := range s.open[resource] {
		w.Modify(obj)
	}
}

// waitOpen waits until the API server stand-in holds this many watches of a resource: a place taken is not yet a watch on.
func (s *scriptedWatches) waitOpen(t *testing.T, resource string, want int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		got := len(s.open[resource])
		s.mu.Unlock()
		if got >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("no %d watches of %s", want, resource)
}

func capturedLog(t *testing.T) *lockedBuffer {
	t.Helper()
	var out lockedBuffer
	was := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&out, nil)))
	t.Cleanup(func() { slog.SetDefault(was) })
	return &out
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// frameOn reads frames until one of this path comes.
func frameOn(t *testing.T, conn *websocket.Conn, path string) frame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		f := nextFrame(t, conn)
		if f.Path == path {
			return f
		}
	}
}

func frameObjectName(f frame) string {
	name, _ := f.Data.Object["name"].(string)
	return name
}

// One object that panics ends that watch: its client is told and the list is read again, the other watches of the
// socket and of another socket go on, the place stays taken, and the watch comes back past that object.
func TestAnObjectThatPanicsEndsOnlyItsOwnWatch(t *testing.T) {
	logged := capturedLog(t)
	script := newScriptedWatches(func(resource string, try int, w *watch.FakeWatcher) {
		if resource != "deployments" {
			return
		}
		if try == 1 {
			w.Modify(deploymentRowPanics("41"))
			return
		}
		w.Modify(objectOf("Deployment", "fine", "42", nil))
	})
	m := NewMultiplexer(fakeClients{script})
	m.PanicRetryDelay = 50 * time.Millisecond
	first, second := socketTo(t, m, everyCluster), socketTo(t, m, everyCluster)
	request(t, first, "REQUEST", "", podsPath, "watch=1")
	request(t, second, "REQUEST", "", podsPath, "watch=1")
	script.waitOpen(t, "pods", 2)

	request(t, first, "REQUEST", "", deploymentsPath, "watch=1")

	failed := frameOn(t, first, deploymentsPath)
	if failed.Type != "ERROR" || failed.Error.Reason != reasonFailed {
		t.Fatalf("first frame of the watch that panicked = %+v", failed)
	}
	if strings.Contains(failed.Error.Message, panicText) {
		t.Fatalf("the client was told the panic's text: %q", failed.Error.Message)
	}
	if back := frameOn(t, first, deploymentsPath); back.Type != "RESYNC" {
		t.Fatalf("after the error = %+v, want RESYNC so the list is read again", back)
	}
	if row := frameOn(t, first, deploymentsPath); row.Type != "DATA" || frameObjectName(row) != "fine" {
		t.Fatalf("after RESYNC = %+v, want the next object's row", row)
	}
	tries := script.triesOf("deployments")
	if len(tries) != 2 || tries[1].version != "41" {
		t.Fatalf("watches asked = %+v, want a second one from version 41, past the object", tries)
	}

	script.tell("pods", objectOf("Pod", "still-here", "7", nil))
	for name, conn := range map[string]*websocket.Conn{"the same socket": first, "another socket": second} {
		if row := frameOn(t, conn, podsPath); row.Type != "DATA" || frameObjectName(row) != "still-here" {
			t.Fatalf("a pod list on %s = %+v", name, row)
		}
	}
	waitForSubscriptions(t, m, 3)

	log := logged.String()
	if !strings.Contains(log, "objectToInfo") || !strings.Contains(log, "forwardEvents") {
		t.Fatalf("the log has no stack down to the row: %s", log)
	}
	if strings.Contains(log, panicText) {
		t.Fatalf("the log holds the panic's text: %s", log)
	}
}

// The same watch panicking every time goes no faster than a watch that fails.
func TestAWatchThatKeepsPanickingWaitsBetweenTries(t *testing.T) {
	const wait = 100 * time.Millisecond
	capturedLog(t)
	var version int
	script := newScriptedWatches(func(_ string, _ int, w *watch.FakeWatcher) {
		version++
		w.Modify(deploymentRowPanics(strings.Repeat("1", version)))
	})
	m := NewMultiplexer(fakeClients{script})
	if got := m.panicWait(); got < 3*time.Second || got >= 7*time.Second {
		t.Fatalf("the wait is %v, want what a failed watch waits, five seconds give or take two", got)
	}
	m.PanicRetryDelay = wait
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "", deploymentsPath, "watch=1")

	script.waitOpen(t, "deployments", 4)

	tries := script.triesOf("deployments")
	for i := 1; i < len(tries); i++ {
		if gap := tries[i].at.Sub(tries[i-1].at); gap < wait {
			t.Fatalf("try %d came %v after the one before, want at least %v", i, gap, wait)
		}
	}
}

// panicsOnCluster panics where the watch gets its client, before any object, for one cluster until told otherwise.
type panicsOnCluster struct {
	fakeClients
	mu     sync.Mutex
	broken string
	asked  int
}

func (p *panicsOnCluster) DynamicForCtx(ctx context.Context) dynamic.Interface {
	id, _ := cluster.FromContext(ctx)
	p.mu.Lock()
	defer p.mu.Unlock()
	if string(id) == p.broken {
		p.asked++
		if p.asked == 1 {
			panic(panicText)
		}
	}
	return p.d
}

// A panic before any object takes the same way out: that watch's client is told, the others go on, and it comes back.
func TestAPanicBeforeAnyObjectEndsOnlyItsOwnWatch(t *testing.T) {
	logged := capturedLog(t)
	script := newScriptedWatches(func(string, int, *watch.FakeWatcher) {})
	m := NewMultiplexer(&panicsOnCluster{fakeClients: fakeClients{script}, broken: "broken"})
	m.PanicRetryDelay = 50 * time.Millisecond
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "fine", podsPath, "watch=1")
	script.waitOpen(t, "pods", 1)

	request(t, conn, "REQUEST", "broken", podsPath, "watch=1")

	failed := nextFrame(t, conn)
	if failed.Type != "ERROR" || failed.ClusterID != "broken" || failed.Error.Reason != reasonFailed {
		t.Fatalf("first frame = %+v", failed)
	}
	if back := nextFrame(t, conn); back.Type != "RESYNC" || back.ClusterID != "broken" {
		t.Fatalf("after the error = %+v, want RESYNC for that watch", back)
	}
	script.tell("pods", objectOf("Pod", "still-here", "7", nil))
	seen := map[string]bool{}
	for range 2 {
		row := nextFrame(t, conn)
		if row.Type != "DATA" || frameObjectName(row) != "still-here" {
			t.Fatalf("a pod list = %+v", row)
		}
		seen[row.ClusterID] = true
	}
	if !seen["fine"] || !seen["broken"] {
		t.Fatalf("rows came for %v, want both clusters", seen)
	}
	if log := logged.String(); strings.Contains(log, panicText) || !strings.Contains(log, "DynamicForCtx") {
		t.Fatalf("the log: %s", log)
	}
}

// A frame that cannot be encoded fails while it is queued, so it ends only its own watch: that list is told and comes
// back after the wait, the socket and its other lists stay, as other sockets do.
func TestAFrameThatCannotBeEncodedEndsOnlyItsOwnWatch(t *testing.T) {
	const wait = 200 * time.Millisecond
	logged := capturedLog(t)
	script := newScriptedWatches(func(string, int, *watch.FakeWatcher) {})
	m := NewMultiplexer(fakeClients{script})
	m.PanicRetryDelay = wait
	broken, other := socketTo(t, m, everyCluster), socketTo(t, m, everyCluster)
	request(t, broken, "REQUEST", "", namespacesPath, "watch=1")
	request(t, broken, "REQUEST", "", podsPath, "watch=1")
	request(t, other, "REQUEST", "", podsPath, "watch=1")
	script.waitOpen(t, "namespaces", 1)
	script.waitOpen(t, "pods", 2)

	sent := time.Now()
	script.tell("namespaces", namespaceFramePanics())

	if failed := frameOn(t, broken, namespacesPath); failed.Type != "ERROR" || failed.Error.Reason != reasonFailed {
		t.Fatalf("the list whose frame could not be encoded = %+v, want ERROR %q", failed, reasonFailed)
	}
	if back := frameOn(t, broken, namespacesPath); back.Type != "RESYNC" {
		t.Fatalf("after the error = %+v, want RESYNC", back)
	} else if took := time.Since(sent); took < wait {
		t.Fatalf("the list came back after %v, want at least %v", took, wait)
	}
	waitForSubscriptions(t, m, 3)

	script.tell("pods", objectOf("Pod", "still-here", "7", nil))
	for name, conn := range map[string]*websocket.Conn{"the same socket": broken, "another socket": other} {
		if row := frameOn(t, conn, podsPath); row.Type != "DATA" || frameObjectName(row) != "still-here" {
			t.Fatalf("a pod list on %s = %+v", name, row)
		}
	}
	if log := logged.String(); strings.Contains(log, panicText) || !strings.Contains(log, "forwardEvents") {
		t.Fatalf("the log: %s", log)
	}
}
