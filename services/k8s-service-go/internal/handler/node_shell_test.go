package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestNodeShellImage(t *testing.T) {
	allowed := []string{"docker.io/library/busybox:latest", " registry.internal/debug:1 "}
	cases := []struct {
		req  string
		want string
		ok   bool
	}{
		{"", "docker.io/library/busybox:latest", true},
		{"docker.io/library/busybox:latest", "docker.io/library/busybox:latest", true},
		{"registry.internal/debug:1", "registry.internal/debug:1", true},
		{"docker.io/library/busybox", "", false}, // tag differs
		{"evil.example/rootkit:latest", "", false},
	}
	for _, c := range cases {
		got, err := nodeShellImage(allowed, c.req)
		if c.ok && (err != nil || got != c.want) {
			t.Fatalf("nodeShellImage(%q) = %q, %v; want %q", c.req, got, err, c.want)
		}
		if !c.ok && err == nil {
			t.Fatalf("nodeShellImage(%q) must be rejected", c.req)
		}
	}
	if _, err := nodeShellImage(nil, ""); err == nil {
		t.Fatal("empty allow list must reject")
	}
}

func TestEnsureNodeShellNamespace(t *testing.T) {
	cs := fake.NewSimpleClientset()
	ctx := context.Background()
	if err := ensureNodeShellNamespace(ctx, cs, "kubeast-node-shell"); err != nil {
		t.Fatal(err)
	}
	ns, err := cs.CoreV1().Namespaces().Get(ctx, "kubeast-node-shell", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if ns.Labels["pod-security.kubernetes.io/enforce"] != "privileged" {
		t.Fatalf("namespace must be labelled privileged, got %v", ns.Labels)
	}
	// idempotent
	if err := ensureNodeShellNamespace(ctx, cs, "kubeast-node-shell"); err != nil {
		t.Fatal(err)
	}
}

// #67: the wait loop reads why the debug pod is not running yet instead of
// timing out without a reason.
func TestPodStartState(t *testing.T) {
	waiting := func(reason, msg string) corev1.PodStatus {
		return corev1.PodStatus{Phase: corev1.PodPending, ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason, Message: msg}}}}}
	}
	cases := []struct {
		name          string
		status        corev1.PodStatus
		state         int
		reason, inMsg string
	}{
		{"just created", corev1.PodStatus{Phase: corev1.PodPending}, podStartPending, "", ""},
		{"creating", waiting("ContainerCreating", ""), podStartPending, "ContainerCreating", ""},
		{"image pull", waiting("ImagePullBackOff", `Back-off pulling image "docker.io/library/busybox:1.38.0"`), podStartPending, "ImagePullBackOff", "busybox:1.38.0"},
		{"pod condition", corev1.PodStatus{Phase: corev1.PodPending, Conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable", Message: "node not ready"}}}, podStartPending, "Unschedulable", "node not ready"},
		{"running", corev1.PodStatus{Phase: corev1.PodRunning}, podStartRunning, "", ""},
		{"container ended", corev1.PodStatus{Phase: corev1.PodFailed, ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", Message: "exec format error"}}}}}, podStartEnded, "Error", "exec format error"},
		{"kubelet refused", corev1.PodStatus{Phase: corev1.PodFailed, Reason: "NodeAffinity", Message: "node mismatch"}, podStartEnded, "NodeAffinity", "node mismatch"},
		{"ended, no detail", corev1.PodStatus{Phase: corev1.PodSucceeded}, podStartEnded, "Succeeded", ""},
	}
	for _, c := range cases {
		state, reason, msg := podStartState(&corev1.Pod{Status: c.status})
		if state != c.state || reason != c.reason || !strings.Contains(msg, c.inMsg) {
			t.Errorf("%s: got %d %q %q, want %d %q (message containing %q)", c.name, state, reason, msg, c.state, c.reason, c.inMsg)
		}
	}
}

func TestWriteShellStatus(t *testing.T) {
	got := make(chan []byte, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		writeShellStatus(conn, shellStatus{Status: shellWaiting, Reason: "ImagePullBackOff", Message: strings.Repeat("x", 600)})
		time.Sleep(100 * time.Millisecond)
	}))
	defer srv.Close()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	mt, data, err := c.ReadMessage()
	if err != nil || mt != websocket.TextMessage {
		t.Fatalf("frame %d %v", mt, err)
	}
	got <- data
	var s shellStatus
	if err := json.Unmarshal(<-got, &s); err != nil {
		t.Fatal(err)
	}
	if s.Type != "status" || s.Status != "waiting" || s.Reason != "ImagePullBackOff" || len(s.Message) > shellStatusMessageMax+len("…") {
		t.Fatalf("status frame %+v (message %d bytes)", s, len(s.Message))
	}
}
