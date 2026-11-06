package ws

import (
	"encoding/json"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/podrow"
)

// A pod as an API server sends it to a watch: two containers and an init container, a dozen environment variables,
// volumes, status for each container and three field managers.
func benchPodJSON() string {
	envs := make([]string, 0, 12)
	for _, name := range []string{"A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"} {
		envs = append(envs, `{"name":"`+name+`","value":"not-a-real-value"}`)
	}
	env := strings.Join(envs, ",")
	container := func(name string) string {
		return `{"name":"` + name + `","image":"registry.example.test/team/app:1.2.3","imagePullPolicy":"IfNotPresent","ports":[{"name":"http","containerPort":8080,"protocol":"TCP"}],
			"resources":{"requests":{"cpu":"100m","memory":"128Mi"},"limits":{"cpu":"1","memory":"1Gi"}},"env":[` + env + `],"envFrom":[{"configMapRef":{"name":"app-conf"}},{"secretRef":{"name":"app-creds"}}],
			"volumeMounts":[{"name":"conf","mountPath":"/etc/app","readOnly":true},{"name":"token","mountPath":"/var/run/secrets/kubernetes.io/serviceaccount","readOnly":true}],
			"livenessProbe":{"httpGet":{"path":"/healthz","port":8080,"scheme":"HTTP"},"timeoutSeconds":1,"periodSeconds":10,"successThreshold":1,"failureThreshold":3},
			"securityContext":{"runAsNonRoot":true,"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},"terminationMessagePath":"/dev/termination-log","terminationMessagePolicy":"File"}`
	}
	status := func(name string) string {
		return `{"name":"` + name + `","image":"registry.example.test/team/app:1.2.3","imageID":"registry.example.test/team/app@sha256:0123456789abcdef","containerID":"containerd://0123456789abcdef","ready":true,"started":true,"restartCount":1,
			"state":{"running":{"startedAt":"2026-11-01T00:01:00Z"}},"lastState":{"terminated":{"exitCode":1,"reason":"Error","containerID":"containerd://fedcba9876543210","startedAt":"2026-11-01T00:00:10Z","finishedAt":"2026-11-01T00:00:50Z"}}}`
	}
	managed := func(manager string) string {
		return `{"manager":"` + manager + `","operation":"Update","apiVersion":"v1","time":"2026-11-01T00:01:00Z","fieldsType":"FieldsV1","fieldsV1":{"f:metadata":{"f:labels":{".":{},"f:app":{}},"f:ownerReferences":{".":{},"k:{\"uid\":\"u-1\"}":{}}},
			"f:spec":{"f:containers":{"k:{\"name\":\"app\"}":{".":{},"f:env":{".":{},"k:{\"name\":\"A\"}":{".":{},"f:name":{},"f:value":{}}},"f:image":{},"f:imagePullPolicy":{},"f:name":{},"f:ports":{".":{},"k:{\"containerPort\":8080,\"protocol\":\"TCP\"}":{".":{},"f:containerPort":{},"f:name":{},"f:protocol":{}}},"f:resources":{".":{},"f:limits":{".":{},"f:cpu":{},"f:memory":{}},"f:requests":{".":{},"f:cpu":{},"f:memory":{}}}}}},
			"f:status":{"f:conditions":{"k:{\"type\":\"Ready\"}":{".":{},"f:lastProbeTime":{},"f:lastTransitionTime":{},"f:status":{},"f:type":{}}},"f:containerStatuses":{},"f:phase":{},"f:podIP":{},"f:podIPs":{".":{},"k:{\"ip\":\"10.0.0.7\"}":{".":{},"f:ip":{}}},"f:startTime":{}}}}`
	}
	return `{"apiVersion":"v1","kind":"Pod","metadata":{"name":"app-7c9f8d6b5-x2x9z","generateName":"app-7c9f8d6b5-","namespace":"team-a","uid":"0d7f1c1e-6b1f-4a7e-9a44-1f7c6c8d2b11","resourceVersion":"123456","creationTimestamp":"2026-11-01T00:00:00Z",
		"labels":{"app":"app","pod-template-hash":"7c9f8d6b5","team":"a"},"annotations":{"prometheus.io/scrape":"true","prometheus.io/port":"8080"},
		"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"app-7c9f8d6b5","uid":"u-1","controller":true,"blockOwnerDeletion":true}],
		"managedFields":[` + managed("kube-controller-manager") + `,` + managed("kubelet") + `,` + managed("kube-scheduler") + `]},
		"spec":{"volumes":[{"name":"conf","configMap":{"name":"app-conf","defaultMode":420}},{"name":"token","projected":{"defaultMode":420,"sources":[{"serviceAccountToken":{"expirationSeconds":3607,"path":"token"}},{"configMap":{"name":"kube-root-ca.crt","items":[{"key":"ca.crt","path":"ca.crt"}]}}]}}],
		"initContainers":[` + container("setup") + `],"containers":[` + container("app") + `,` + container("side") + `],"restartPolicy":"Always","terminationGracePeriodSeconds":30,"dnsPolicy":"ClusterFirst","serviceAccountName":"app","serviceAccount":"app","nodeName":"node-a","priority":0,"enableServiceLinks":true,"preemptionPolicy":"PreemptLowerPriority",
		"tolerations":[{"key":"node.kubernetes.io/not-ready","operator":"Exists","effect":"NoExecute","tolerationSeconds":300},{"key":"node.kubernetes.io/unreachable","operator":"Exists","effect":"NoExecute","tolerationSeconds":300}]},
		"status":{"phase":"Running","hostIP":"192.0.2.10","podIP":"10.0.0.7","podIPs":[{"ip":"10.0.0.7"}],"startTime":"2026-11-01T00:00:00Z","qosClass":"Burstable",
		"conditions":[{"type":"Initialized","status":"True","lastTransitionTime":"2026-11-01T00:00:30Z"},{"type":"Ready","status":"True","lastTransitionTime":"2026-11-01T00:01:10Z"},{"type":"ContainersReady","status":"True","lastTransitionTime":"2026-11-01T00:01:10Z"},{"type":"PodScheduled","status":"True","lastTransitionTime":"2026-11-01T00:00:00Z"}],
		"initContainerStatuses":[` + status("setup") + `],"containerStatuses":[` + status("app") + `,` + status("side") + `]}}`
}

// A namespace's pods come one event each, so a row stays well under what the reflective converter would cost it.
func TestALivePodRowCostsLessThanTheConverter(t *testing.T) {
	var obj unstructured.Unstructured
	if err := obj.UnmarshalJSON([]byte(benchPodJSON())); err != nil {
		t.Fatal(err)
	}
	row := testing.AllocsPerRun(100, func() { podToInfo(&obj) })
	converted := testing.AllocsPerRun(100, func() {
		var p corev1.Pod
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &p); err != nil {
			t.Fatal(err)
		}
		podrow.Info(&p)
	})
	if row*2 > converted {
		t.Errorf("a row takes %.0f allocations, the converter and the row %.0f", row, converted)
	}
}

// What one pod event costs k8s-service, by its parts: reading the event, making the row and writing the frame.
func BenchmarkPodFrame(b *testing.B) {
	raw := []byte(benchPodJSON())
	object := func(b *testing.B) *unstructured.Unstructured {
		var obj unstructured.Unstructured
		if err := obj.UnmarshalJSON(raw); err != nil {
			b.Fatal(err)
		}
		return &obj
	}
	b.Run("read", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			object(b)
		}
	})
	b.Run("row", func(b *testing.B) {
		obj := object(b)
		b.ReportAllocs()
		for b.Loop() {
			objectToInfo("pods", obj)
		}
	})
	b.Run("write", func(b *testing.B) {
		row := objectToInfo("pods", object(b))
		frame, err := json.Marshal(row)
		if err != nil {
			b.Fatal(err)
		}
		b.ReportAllocs()
		for b.Loop() {
			if _, err := json.Marshal(row); err != nil {
				b.Fatal(err)
			}
		}
		b.ReportMetric(float64(len(raw)), "event-bytes")
		b.ReportMetric(float64(len(frame)), "frame-bytes")
	})
}
