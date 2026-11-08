package k8s

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer/protobuf"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// listedPod is a pod as the API server lists one a Deployment made: managed fields, a projected token volume, five
// conditions, a running container.
func listedPod(ns, node string, i int) corev1.Pod {
	created := metav1.NewTime(time.Date(2026, 11, 1, 2, 3, 4, 0, time.UTC))
	rs := fmt.Sprintf("bulk-%03d-6d8f9c7b5d", i%100)
	return corev1.Pod{
		TypeMeta: metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{
			Name: fmt.Sprintf("%s-%05d", rs, i), GenerateName: rs + "-", Namespace: ns,
			UID: "3f0c8a3e-6a55-4d0e-9a4b-1f2d3c4b5a69", ResourceVersion: fmt.Sprint(100000 + i), CreationTimestamp: created,
			Labels:          map[string]string{"app": fmt.Sprintf("bulk-%03d", i%100), "pod-template-hash": "6d8f9c7b5d"},
			OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: rs, UID: "8a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d", Controller: ptrTo(true), BlockOwnerDeletion: ptrTo(true)}},
			ManagedFields: []metav1.ManagedFieldsEntry{
				{Manager: "kube-controller-manager", Operation: metav1.ManagedFieldsOperationUpdate, APIVersion: "v1", Time: &created, FieldsType: "FieldsV1",
					FieldsV1: &metav1.FieldsV1{Raw: []byte(`{"f:metadata":{"f:generateName":{},"f:labels":{".":{},"f:app":{},"f:pod-template-hash":{}},"f:ownerReferences":{".":{},"k:{\"uid\":\"8a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d\"}":{}}},"f:spec":{"f:containers":{"k:{\"name\":\"app\"}":{".":{},"f:image":{},"f:imagePullPolicy":{},"f:name":{},"f:ports":{".":{},"k:{\"containerPort\":8080,\"protocol\":\"TCP\"}":{".":{},"f:containerPort":{},"f:name":{},"f:protocol":{}}},"f:resources":{".":{},"f:limits":{".":{},"f:memory":{}},"f:requests":{".":{},"f:cpu":{},"f:memory":{}}},"f:terminationMessagePath":{},"f:terminationMessagePolicy":{}}},"f:dnsPolicy":{},"f:enableServiceLinks":{},"f:restartPolicy":{},"f:schedulerName":{},"f:securityContext":{},"f:terminationGracePeriodSeconds":{}}}`)}},
				{Manager: "kwok", Operation: metav1.ManagedFieldsOperationUpdate, APIVersion: "v1", Time: &created, FieldsType: "FieldsV1", Subresource: "status",
					FieldsV1: &metav1.FieldsV1{Raw: []byte(`{"f:status":{"f:conditions":{"k:{\"type\":\"ContainersReady\"}":{".":{},"f:lastTransitionTime":{},"f:status":{},"f:type":{}},"k:{\"type\":\"Initialized\"}":{".":{},"f:lastTransitionTime":{},"f:status":{},"f:type":{}},"k:{\"type\":\"PodReadyToStartContainers\"}":{".":{},"f:lastTransitionTime":{},"f:status":{},"f:type":{}},"k:{\"type\":\"PodScheduled\"}":{"f:lastTransitionTime":{}},"k:{\"type\":\"Ready\"}":{".":{},"f:lastTransitionTime":{},"f:status":{},"f:type":{}}},"f:containerStatuses":{},"f:hostIP":{},"f:hostIPs":{},"f:phase":{},"f:podIP":{},"f:podIPs":{".":{},"k:{\"ip\":\"10.0.1.2\"}":{".":{},"f:ip":{}}},"f:startTime":{}}}`)}},
			},
		},
		Spec: corev1.PodSpec{
			NodeName: node, ServiceAccountName: "default", DNSPolicy: corev1.DNSClusterFirst, RestartPolicy: corev1.RestartPolicyAlways,
			SchedulerName: "default-scheduler", TerminationGracePeriodSeconds: ptrTo(int64(30)), EnableServiceLinks: ptrTo(true),
			Containers: []corev1.Container{{
				Name: "app", Image: "registry.example.com/bulk/app:1.4.2", ImagePullPolicy: corev1.PullIfNotPresent,
				Ports: []corev1.ContainerPort{{Name: "http", ContainerPort: 8080, Protocol: corev1.ProtocolTCP}},
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m"), corev1.ResourceMemory: resource.MustParse("16Mi")},
					Limits:   corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("64Mi")},
				},
				VolumeMounts:             []corev1.VolumeMount{{Name: "kube-api-access-x7k2p", MountPath: "/var/run/secrets/kubernetes.io/serviceaccount", ReadOnly: true}},
				TerminationMessagePath:   "/dev/termination-log",
				TerminationMessagePolicy: corev1.TerminationMessageReadFile,
			}},
			Volumes: []corev1.Volume{{Name: "kube-api-access-x7k2p", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{
				DefaultMode: ptrTo(int32(420)),
				Sources: []corev1.VolumeProjection{
					{ServiceAccountToken: &corev1.ServiceAccountTokenProjection{Path: "token", ExpirationSeconds: ptrTo(int64(3607))}},
					{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "kube-root-ca.crt"}, Items: []corev1.KeyToPath{{Key: "ca.crt", Path: "ca.crt"}}}},
					{DownwardAPI: &corev1.DownwardAPIProjection{Items: []corev1.DownwardAPIVolumeFile{{Path: "namespace", FieldRef: &corev1.ObjectFieldSelector{APIVersion: "v1", FieldPath: "metadata.namespace"}}}}},
				},
			}}}},
			Tolerations: []corev1.Toleration{
				{Key: "node.kubernetes.io/not-ready", Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoExecute, TolerationSeconds: ptrTo(int64(300))},
				{Key: "node.kubernetes.io/unreachable", Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoExecute, TolerationSeconds: ptrTo(int64(300))},
			},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning, HostIP: "172.18.0.3", PodIP: "10.0.1.2", StartTime: &created, QOSClass: corev1.PodQOSBurstable,
			HostIPs: []corev1.HostIP{{IP: "172.18.0.3"}}, PodIPs: []corev1.PodIP{{IP: "10.0.1.2"}},
			Conditions: []corev1.PodCondition{
				{Type: "PodReadyToStartContainers", Status: corev1.ConditionTrue, LastTransitionTime: created},
				{Type: corev1.PodInitialized, Status: corev1.ConditionTrue, LastTransitionTime: created},
				{Type: corev1.PodReady, Status: corev1.ConditionTrue, LastTransitionTime: created},
				{Type: corev1.ContainersReady, Status: corev1.ConditionTrue, LastTransitionTime: created},
				{Type: corev1.PodScheduled, Status: corev1.ConditionTrue, LastTransitionTime: created},
			},
			ContainerStatuses: []corev1.ContainerStatus{{
				Name: "app", Ready: true, Started: ptrTo(true), Image: "registry.example.com/bulk/app:1.4.2", ImageID: "registry.example.com/bulk/app@sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
				ContainerID: "containerd://5b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c",
				State:       corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: created}},
			}},
		},
	}
}

// podListAPI serves the pods of a node, perList in each list, as the API server does for a list with a field selector:
// protobuf to a client that asks for it, as client-go does for pods, else JSON.
func podListAPI(t testing.TB, perList int) *Service {
	t.Helper()
	type bodies struct{ json, proto []byte }
	encoded := map[string]bodies{}
	var mu sync.Mutex
	body := func(ns string) bodies {
		mu.Lock()
		defer mu.Unlock()
		if b, ok := encoded[ns]; ok {
			return b
		}
		list := &corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, ListMeta: metav1.ListMeta{ResourceVersion: "123456"}}
		for i := 0; i < perList; i++ {
			list.Items = append(list.Items, listedPod(ns, "node-0001", i))
		}
		var b bodies
		b.json, _ = json.Marshal(list)
		var proto bytes.Buffer
		if err := protobuf.NewSerializer(scheme.Scheme, scheme.Scheme).Encode(list, &proto); err != nil {
			t.Fatal(err)
		}
		b.proto = proto.Bytes()
		encoded[ns] = b
		return b
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ns := "bulk"
		if rest, ok := strings.CutPrefix(r.URL.Path, "/api/v1/namespaces/"); ok {
			ns, _, _ = strings.Cut(rest, "/")
		} else if r.URL.Path != "/api/v1/pods" {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(r.Header.Get("Accept"), k8sruntime.ContentTypeProtobuf) {
			w.Header().Set("Content-Type", k8sruntime.ContentTypeProtobuf)
			_, _ = w.Write(body(ns).proto)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body(ns).json)
	}))
	t.Cleanup(srv.Close)
	cfg := &rest.Config{Host: srv.URL, QPS: -1}
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return auth.ImpersonationRoundTripper(rt, "default") })
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	return s
}

// stalledReader is a client whose connection takes nothing until it is released: a write waits there, as on a full
// socket.
type stalledReader struct {
	header  http.Header
	inWrite chan<- struct{}
	release <-chan struct{}
	once    sync.Once
	wrote   int
}

func (w *stalledReader) Header() http.Header { return w.header }
func (w *stalledReader) WriteHeader(int)     {}
func (w *stalledReader) Write(p []byte) (int, error) {
	w.once.Do(func() { w.inWrite <- struct{}{} })
	<-w.release
	w.wrote += len(p)
	return len(p), nil
}

func liveBytes() (heap, stack uint64) {
	runtime.GC()
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc, m.StackInuse
}

// heldWhileAnswersWait runs k requests whose answers wait on clients that read nothing and returns what one of them
// holds then (heap and stack bytes) and the bytes each answer had.
func heldWhileAnswersWait(t testing.TB, k int, request func(ctx context.Context, w http.ResponseWriter)) (heap, stack float64, answer int) {
	t.Helper()
	inWrite := make(chan struct{}, k)
	release := make(chan struct{})
	writers := make([]*stalledReader, k)
	for i := range writers {
		writers[i] = &stalledReader{header: http.Header{}, inWrite: inWrite, release: release}
	}
	var wg sync.WaitGroup
	for i := 0; i < k; i++ { // the connections to the cluster are in the baseline, not counted per request
		wg.Add(1)
		go func() { defer wg.Done(); request(callerCtx("warm@example.com"), discardWriter{}) }()
	}
	wg.Wait()
	heap0, stack0 := liveBytes()
	for i := 0; i < k; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			request(callerCtx(fmt.Sprintf("crowd-%03d@example.com", i)), writers[i])
		}(i)
	}
	for i := 0; i < k; i++ {
		select {
		case <-inWrite:
		case <-time.After(20 * time.Second):
			close(release)
			t.Fatalf("only %d of %d answers reached their client", i, k)
		}
	}
	heap1, stack1 := liveBytes()
	close(release)
	wg.Wait()
	return (float64(heap1) - float64(heap0)) / float64(k), (float64(stack1) - float64(stack0)) / float64(k), writers[0].wrote
}

// podsOnNodeRequest is the on-node handler's work: the pods listed as the caller, answered as JSON.
func podsOnNodeRequest(s *Service) func(ctx context.Context, w http.ResponseWriter) {
	return func(ctx context.Context, w http.ResponseWriter) {
		data, err := s.GetPodsOnNode(ctx, "node-0001", "")
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		response.JSON(w, http.StatusOK, data)
	}
}

// What a crowd's request for a node's pods holds while its answer waits on a client that reads nothing.
func TestPodsOnNodeAnswerWaitingOnItsClientHoldsLittle(t *testing.T) {
	s := podListAPI(t, 40)
	heap, stack, answer := heldWhileAnswersWait(t, 100, podsOnNodeRequest(s))
	t.Logf("on-node, 40 pods: answer %d bytes; held per waiting request: heap %.0f bytes, stack %.0f bytes", answer, heap, stack)
	if heap > 1.25*float64(answer) {
		t.Errorf("a waiting request holds %.0f heap bytes for an answer of %d, want at most 1.25 times the answer", heap, answer)
	}
}

// A grant of 20 namespaces read eight at a time keeps eight goroutines, not one per namespace waiting its turn.
func TestFanOutKeepsNoMoreGoroutinesThanItReadsAtOnce(t *testing.T) {
	release := make(chan struct{})
	reading := make(chan struct{}, 20)
	done := make(chan []string)
	go func() {
		got, _ := fanOutNamespaces(scopeOf(20), func(ns string) ([]string, error) {
			reading <- struct{}{}
			<-release
			return []string{ns}, nil
		})
		done <- got
	}()
	for i := 0; i < listFanOutWorkers; i++ {
		<-reading
	}
	time.Sleep(50 * time.Millisecond) // let any goroutine started for a later namespace park
	buf := make([]byte, 1<<22)
	stacks := string(buf[:runtime.Stack(buf, true)])
	fanning := 0
	for _, g := range strings.Split(stacks, "\n\n") {
		if strings.Contains(g, "internal/k8s.fanOutNamespaces") {
			fanning++
		}
	}
	close(release)
	got := <-done
	// the goroutine that called fanOutNamespaces is one of them
	if fanning-1 > listFanOutWorkers {
		t.Errorf("%d goroutines while %d namespaces were read, want at most %d", fanning-1, listFanOutWorkers, listFanOutWorkers)
	}
	if strings.Join(got, ",") != strings.Join(scopeOf(20), ",") {
		t.Errorf("rows %v, want the grant's order", got)
	}
}

// BenchmarkPodsOnNodeAnswer is the bytes one on-node request allocates for a node of 40 pods.
func BenchmarkPodsOnNodeAnswer(b *testing.B) {
	s := podListAPI(b, 40)
	request := podsOnNodeRequest(s)
	ctx := callerCtx("bench@example.com")
	b.ReportAllocs()
	for b.Loop() {
		request(ctx, discardWriter{})
	}
}

type discardWriter struct{}

func (discardWriter) Header() http.Header         { return http.Header{} }
func (discardWriter) WriteHeader(int)             {}
func (discardWriter) Write(p []byte) (int, error) { return io.Discard.Write(p) }
