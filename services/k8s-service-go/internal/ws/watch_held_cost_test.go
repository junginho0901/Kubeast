package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

// watchPodJSON is a pod as the API server sends it on a watch: labels, an owner, one container, status and the
// managedFields of the controller, the scheduler and the kubelet.
func watchPodJSON(i int) []byte {
	fields := func(manager, sub string) metav1.ManagedFieldsEntry {
		raw := `{"f:metadata":{"f:generateName":{},"f:labels":{".":{},"f:app":{},"f:controller-revision-hash":{},"f:pod-template-generation":{}},"f:ownerReferences":{".":{},"k:{\"uid\":\"6f1c\"}":{}}},"f:spec":{"f:affinity":{".":{},"f:nodeAffinity":{".":{},"f:requiredDuringSchedulingIgnoredDuringExecution":{}}},"f:containers":{"k:{\"name\":\"app\"}":{".":{},"f:image":{},"f:imagePullPolicy":{},"f:name":{},"f:resources":{},"f:terminationMessagePath":{},"f:terminationMessagePolicy":{}}},"f:dnsPolicy":{},"f:enableServiceLinks":{},"f:restartPolicy":{},"f:schedulerName":{},"f:securityContext":{},"f:terminationGracePeriodSeconds":{},"f:tolerations":{}}}`
		if sub == "status" {
			raw = `{"f:status":{"f:conditions":{"k:{\"type\":\"ContainersReady\"}":{".":{},"f:lastProbeTime":{},"f:lastTransitionTime":{},"f:status":{},"f:type":{}},"k:{\"type\":\"Initialized\"}":{".":{},"f:lastProbeTime":{},"f:lastTransitionTime":{},"f:status":{},"f:type":{}},"k:{\"type\":\"Ready\"}":{".":{},"f:lastProbeTime":{},"f:lastTransitionTime":{},"f:status":{},"f:type":{}}},"f:containerStatuses":{},"f:hostIP":{},"f:phase":{},"f:podIP":{},"f:podIPs":{".":{},"k:{\"ip\":\"10.0.0.1\"}":{".":{},"f:ip":{}}},"f:startTime":{}}}`
		}
		return metav1.ManagedFieldsEntry{Manager: manager, Operation: metav1.ManagedFieldsOperationUpdate, APIVersion: "v1", Subresource: sub, FieldsType: "FieldsV1", FieldsV1: &metav1.FieldsV1{Raw: []byte(raw)}}
	}
	yes := true
	now := metav1.NewTime(time.Unix(1_794_000_000, 0))
	pod := corev1.Pod{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"},
		ObjectMeta: metav1.ObjectMeta{
			Name: fmt.Sprintf("load-ds-%05d", i), GenerateName: "load-ds-", Namespace: "bulk", UID: "0a1b2c3d-0000-4000-8000-000000000000",
			ResourceVersion: fmt.Sprint(1_000_000 + i), CreationTimestamp: now,
			Labels:          map[string]string{"app": "load-ds", "controller-revision-hash": "7d9f8c6b5", "pod-template-generation": "3"},
			OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "DaemonSet", Name: "load-ds", UID: "6f1c", Controller: &yes, BlockOwnerDeletion: &yes}},
			ManagedFields:   []metav1.ManagedFieldsEntry{fields("kube-controller-manager", ""), fields("kwok", "status")},
		},
		Spec: corev1.PodSpec{
			NodeName:    fmt.Sprintf("kwok-node-%d", i),
			Containers:  []corev1.Container{{Name: "app", Image: "fake-image", TerminationMessagePath: "/dev/termination-log", TerminationMessagePolicy: "File", ImagePullPolicy: "IfNotPresent"}},
			Tolerations: []corev1.Toleration{{Key: "kwok.x-k8s.io/node", Operator: "Exists", Effect: "NoSchedule"}, {Key: "node.kubernetes.io/not-ready", Operator: "Exists", Effect: "NoExecute"}},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning, HostIP: "10.0.0.2", PodIP: "10.0.0.1", StartTime: &now,
			Conditions:        []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue, LastTransitionTime: now}, {Type: corev1.ContainersReady, Status: corev1.ConditionTrue, LastTransitionTime: now}},
			ContainerStatuses: []corev1.ContainerStatus{{Name: "app", Ready: true, Image: "fake-image", ImageID: "fake-image", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: now}}}},
		},
	}
	b, _ := json.Marshal(map[string]any{"type": "ADDED", "object": pod})
	return b
}

// A socket whose browser reads slower than the cluster changes holds a full queue: each frame waits as its JSON, not as
// the row's map, which took some 8 KiB a pod.
func TestASocketBehindHoldsItsQueuedFramesAsJSON(t *testing.T) {
	const sockets, queued = 8, 256
	var written atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		for i := 0; i < queued; i++ {
			line := append(watchPodJSON(i), '\n')
			if _, err := w.Write(line); err != nil {
				return
			}
			written.Add(1)
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	d, err := dynamic.NewForConfig(&rest.Config{Host: server.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	m := NewMultiplexer(fakeClients{d})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	queues := make([]chan ResponseMessage, sockets)
	for i := range queues {
		queues[i] = make(chan ResponseMessage, queued)
		go m.runWatch(ctx, RequestMessage{Type: "REQUEST", Path: "/api/v1/namespaces/bulk/pods", Query: "watch=1"}, queues[i])
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		full := 0
		for _, q := range queues {
			if len(q) == queued {
				full++
			}
		}
		if full == sockets {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d queues filled", full, sockets)
		}
		time.Sleep(20 * time.Millisecond)
	}
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	perSocket := float64(after.HeapInuse-before.HeapInuse) / sockets / (1 << 20)
	if perSocket > 1 {
		t.Errorf("a socket behind holds %.2f MiB for %d queued pod frames, want under 1 MiB", perSocket, queued)
	}
	t.Logf("a socket behind holds %.2f MiB for %d queued pod frames", perSocket, queued)
}

// TestStalledWatchSubscriberHeldCost measures what k8s-service keeps for one live list whose browser reads slower than
// the cluster changes: a watch of a workload's pods with its socket's queue full. Run with WATCH_HELD_COST=1.
func TestStalledWatchSubscriberHeldCost(t *testing.T) {
	if os.Getenv("WATCH_HELD_COST") == "" {
		t.Skip("set WATCH_HELD_COST=1 to measure")
	}
	t.Logf("one pod on the wire: %d bytes", len(watchPodJSON(0)))
	for _, pods := range []int{100, 500, 1000, 2000} {
		for _, drained := range []bool{false, true} {
			const watches = 10
			var written atomic.Int64
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				for i := 0; i < pods; i++ {
					line := append(watchPodJSON(i), '\n')
					if _, err := w.Write(line); err != nil {
						return
					}
					written.Add(int64(len(line)))
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
			}))
			server.EnableHTTP2 = true
			server.StartTLS()
			d, err := dynamic.NewForConfig(&rest.Config{Host: server.URL, QPS: -1, TLSClientConfig: rest.TLSClientConfig{Insecure: true}})
			if err != nil {
				t.Fatal(err)
			}
			m := NewMultiplexer(fakeClients{d})
			ctx, cancel := context.WithCancel(context.Background())
			runtime.GC()
			var before runtime.MemStats
			runtime.ReadMemStats(&before)
			queues := make([]chan ResponseMessage, watches)
			for i := range queues {
				queues[i] = make(chan ResponseMessage, 256)
				if drained {
					go func(ch chan ResponseMessage) {
						for range ch {
						}
					}(queues[i])
				}
				go m.runWatch(ctx, RequestMessage{Type: "REQUEST", Path: "/api/v1/namespaces/bulk/pods", Query: "watch=1&labelSelector=app%3Dload-ds"}, queues[i])
			}
			// settle: the server has sent what the client's windows take
			last := int64(-1)
			for written.Load() != last {
				last = written.Load()
				time.Sleep(500 * time.Millisecond)
			}
			runtime.GC()
			var after runtime.MemStats
			runtime.ReadMemStats(&after)
			held := float64(after.HeapInuse-before.HeapInuse) / (1 << 20)
			t.Logf("%4d pods, socket %-7s: server sent %5.1f MiB per watch, k8s-service holds %5.1f MiB per watch (%d watches)",
				pods, map[bool]string{false: "behind", true: "keeping"}[drained], float64(written.Load())/watches/(1<<20), held/watches, watches)
			cancel()
			server.CloseClientConnections()
			server.Close()
		}
	}
}
