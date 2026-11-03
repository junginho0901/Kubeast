package k8s

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func gpuList(kv ...string) corev1.ResourceList {
	l := corev1.ResourceList{}
	for i := 0; i+1 < len(kv); i += 2 {
		l[corev1.ResourceName(kv[i])] = resource.MustParse(kv[i+1])
	}
	return l
}

// a container as the API server keeps it: the request set to the limit written
func gpuBox(name string, kv ...string) corev1.Container {
	l := gpuList(kv...)
	return corev1.Container{Name: name, Resources: corev1.ResourceRequirements{Requests: l, Limits: l}}
}

func gpuNodeObj(name string, ready corev1.ConditionStatus, cordoned bool, labels map[string]string, capacity corev1.ResourceList) corev1.Node {
	return corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels},
		Spec:       corev1.NodeSpec{Unschedulable: cordoned},
		Status: corev1.NodeStatus{
			Capacity: capacity, Allocatable: capacity,
			Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: ready}},
		},
	}
}

func gpuPodObj(name, node string, phase corev1.PodPhase, init []corev1.Container, containers ...corev1.Container) corev1.Pod {
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "ml"},
		Spec:       corev1.PodSpec{NodeName: node, InitContainers: init, Containers: containers},
		Status:     corev1.PodStatus{Phase: phase},
	}
}

func gpuRow(t *testing.T, rows []map[string]interface{}, name string) map[string]interface{} {
	t.Helper()
	for _, r := range rows {
		if r["name"] == name {
			return r
		}
	}
	t.Fatalf("no row %s in %v", name, rows)
	return nil
}

// The GPUs in use are kubectl describe node's "Allocated resources" (the pods on a node not Succeeded or Failed, each
// pod's request as the scheduler counts it: init containers at their peak, sidecars added); the pods no node has taken
// are waiting, apart. nvidia.com/gpu and nvidia.com/mig-* add up, in the capacity as in the requests. A pod's Status is
// kubectl's STATUS, a node's kubectl's too, and MIG is on for a strategy other than none.
func TestGPUDashboard_CountsAsKubectlDescribeNode(t *testing.T) {
	always := corev1.ContainerRestartPolicyAlways
	sidecar := gpuBox("sidecar", "nvidia.com/mig-1g.5gb", "1")
	sidecar.RestartPolicy = &always
	crash := gpuPodObj("crash", "a", corev1.PodRunning, nil, gpuBox("app", "nvidia.com/gpu", "1"))
	crash.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "app", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}}}
	failed := gpuPodObj("failed", "a", corev1.PodFailed, nil, gpuBox("app", "nvidia.com/gpu", "1"))
	failed.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "app", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1}}}}
	api := &listAPI{
		pods: []corev1.Pod{
			gpuPodObj("one", "a", corev1.PodRunning, nil, gpuBox("app", "nvidia.com/gpu", "1")),
			gpuPodObj("two-cards", "a", corev1.PodRunning, nil, gpuBox("app", "nvidia.com/gpu", "2")),
			gpuPodObj("two-boxes", "a", corev1.PodRunning, nil, gpuBox("a", "nvidia.com/gpu", "1"), gpuBox("b", "nvidia.com/gpu", "1")),
			// an init container's 3 is more than the app's 1: the scheduler holds 3
			gpuPodObj("init-peak", "b", corev1.PodRunning, []corev1.Container{gpuBox("prep", "nvidia.com/gpu", "3")}, gpuBox("app", "nvidia.com/gpu", "1")),
			// a sidecar's MIG device adds to the app's
			gpuPodObj("with-sidecar", "b", corev1.PodRunning, []corev1.Container{sidecar}, gpuBox("app", "nvidia.com/mig-1g.5gb", "1")),
			crash,
			gpuPodObj("done", "a", corev1.PodSucceeded, nil, gpuBox("app", "nvidia.com/gpu", "4")),
			failed,
			gpuPodObj("waiting", "", corev1.PodPending, nil, gpuBox("app", "nvidia.com/gpu", "2")),
			gpuPodObj("no-gpu", "a", corev1.PodRunning, nil, gpuBox("app", "cpu", "1")),
		},
		objects: map[string]any{"/api/v1/nodes": corev1.NodeList{Items: []corev1.Node{
			gpuNodeObj("a", corev1.ConditionTrue, true, map[string]string{"nvidia.com/mig.strategy": "none", "nvidia.com/cuda.driver.major": "550", "nvidia.com/cuda.driver.minor": "54", "nvidia.com/cuda.driver.rev": "15"},
				gpuList("cpu", "4", "nvidia.com/gpu", "8")),
			gpuNodeObj("b", corev1.ConditionFalse, false, map[string]string{"nvidia.com/mig.strategy": "mixed", "nvidia.com/cuda.driver-version.full": "580.95.05", "nvidia.com/cuda.driver.major": "580"},
				gpuList("nvidia.com/gpu", "4", "nvidia.com/mig-1g.5gb", "7")),
			gpuNodeObj("cpu-only", corev1.ConditionTrue, false, nil, gpuList("cpu", "4")),
		}}},
	}
	res, err := api.serve(t).GetGPUDashboard(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// node a: one 1 + two-cards 2 + two-boxes 2 + crash 1 = 6 (done and failed have ended); node b: init-peak 3 +
	// with-sidecar 2 = 5; waiting 2
	got := map[string]interface{}{"capacity": res["total_gpu_capacity"], "allocatable": res["total_gpu_allocatable"], "used": res["total_gpu_used"], "waiting": res["total_gpu_waiting"], "mig": res["mig_enabled"]}
	want := map[string]interface{}{"capacity": 19, "allocatable": 19, "used": 11, "waiting": 2, "mig": true}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %v, want %v (all %v)", k, got[k], v, got)
		}
	}
	nodes := res["gpu_nodes"].([]map[string]interface{})
	if len(nodes) != 2 {
		t.Fatalf("GPU nodes %v", nodes)
	}
	for _, c := range []struct {
		name, status, driver string
		capacity, used       int
	}{{"a", "Ready,SchedulingDisabled", "550.54.15", 8, 6}, {"b", "NotReady", "580.95.05", 11, 5}} {
		n := gpuRow(t, nodes, c.name)
		if n["status"] != c.status || n["driver_version"] != c.driver || n["gpu_capacity"] != c.capacity || n["gpu_used"] != c.used {
			t.Errorf("node %s: %v, want status %s driver %s capacity %d used %d", c.name, n, c.status, c.driver, c.capacity, c.used)
		}
	}
	pods := res["gpu_pods"].([]map[string]interface{})
	if len(pods) != 9 {
		t.Fatalf("GPU pods %d: %v", len(pods), pods)
	}
	for name, w := range map[string][3]interface{}{
		// status, phase, GPUs
		"one": {"Running", "Running", 1}, "init-peak": {"Running", "Running", 3}, "with-sidecar": {"Running", "Running", 2},
		"crash": {"CrashLoopBackOff", "Running", 1}, "done": {"Succeeded", "Succeeded", 4}, "failed": {"Error", "Failed", 1},
		"waiting": {"Pending", "Pending", 2},
	} {
		r := gpuRow(t, pods, name)
		if r["status"] != w[0] || r["phase"] != w[1] || r["gpu_requested"] != w[2] {
			t.Errorf("pod %s: %v, want %v", name, r, w)
		}
	}
	if _, ok := gpuRow(t, pods, "waiting")["node_name"]; ok {
		t.Errorf("a pod no node has taken has a node: %v", gpuRow(t, pods, "waiting"))
	}
	if gpuRow(t, pods, "one")["node_name"] != "a" {
		t.Errorf("node of one: %v", gpuRow(t, pods, "one"))
	}
}

// MIG is off when no GPU node names a strategy or each names none.
func TestGPUDashboard_MIGNoneIsOff(t *testing.T) {
	api := &listAPI{objects: map[string]any{"/api/v1/nodes": corev1.NodeList{Items: []corev1.Node{
		gpuNodeObj("a", corev1.ConditionTrue, false, map[string]string{"nvidia.com/mig.strategy": "none"}, gpuList("nvidia.com/gpu", "1")),
		gpuNodeObj("b", corev1.ConditionTrue, false, nil, gpuList("nvidia.com/gpu", "1")),
	}}}}
	res, err := api.serve(t).GetGPUDashboard(context.Background())
	if err != nil || res["mig_enabled"] != false {
		t.Fatalf("mig %v %v", res["mig_enabled"], err)
	}
}

// The DCGM labels read as the exporter writes them now and before: hostname (Hostname until 4.6.0), UUID or uuid,
// and the GPU's pod as exported_pod where the scrape renamed it, else pod.
func TestGPUMetrics_ReadsTheExportersLabels(t *testing.T) {
	series := `{"resultType":"vector","result":[` +
		`{"metric":{"UUID":"GPU-a","gpu":"0","hostname":"n1","modelName":"A100","pod":"train-0","namespace":"ml"},"value":[1,"40"]},` +
		`{"metric":{"UUID":"GPU-b","gpu":"1","Hostname":"n1","modelName":"A100","exported_pod":"train-1","exported_namespace":"ml","pod":"dcgm-exporter-x","namespace":"gpu-operator"},"value":[1,"40"]},` +
		`{"metric":{"uuid":"GPU-c","gpu":"2","hostname":"n2","modelName":"A100"},"value":[1,"40"]}]}`
	f := &fakeStore{paths: map[string]string{"/api/v1/query": series}}
	got, err := storeService(t, f, "").GetGPUMetrics(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	byUUID := map[string]map[string]interface{}{}
	for _, g := range got["gpus"].([]map[string]interface{}) {
		byUUID[g["uuid"].(string)] = g
	}
	want := map[string][3]string{"GPU-a": {"n1", "ml", "train-0"}, "GPU-b": {"n1", "ml", "train-1"}, "GPU-c": {"n2", "", ""}}
	if len(byUUID) != len(want) {
		t.Fatalf("GPUs %v", byUUID)
	}
	for uuid, w := range want {
		g := byUUID[uuid]
		if g["hostname"] != w[0] || g["exported_namespace"] != w[1] || g["exported_pod"] != w[2] {
			t.Errorf("%s: %v, want host %s pod %s/%s", uuid, g, w[0], w[1], w[2])
		}
	}
}
