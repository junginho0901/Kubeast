package k8s

import (
	"context"
	"reflect"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
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

// A GPU is a device of a name one of the three companies' device plugins advertises one GPU per device under —
// NVIDIA's GPUs and MIG profiles (renamed .shared too), AMD's GPUs and mixed-strategy partitions, Intel's GPUs by
// kernel driver — and of no
// other name: not Intel's monitoring resources nor its older plugin's millicores, memory.max and tiles, not other
// accelerators.
func TestGPUVendorOf(t *testing.T) {
	for name, want := range map[string]string{
		"nvidia.com/gpu": "NVIDIA", "nvidia.com/mig-1g.5gb": "NVIDIA", "nvidia.com/mig-3g.40gb": "NVIDIA",
		// the device plugin's sharing config with renameByDefault: each replica one device, as nvidia.com/gpu's are
		"nvidia.com/gpu.shared": "NVIDIA", "nvidia.com/mig-1g.5gb.shared": "NVIDIA",
		"amd.com/gpu": "AMD", "amd.com/cpx_nps4": "AMD", "amd.com/spx_nps1": "AMD", "amd.com/dpx_nps2": "AMD", "amd.com/qpx_nps8": "AMD",
		"gpu.intel.com/i915": "Intel", "gpu.intel.com/xe": "Intel",
		"gpu.intel.com/millicores": "", "gpu.intel.com/memory.max": "", "gpu.intel.com/tiles": "", "gpu.intel.com/monitoring": "",
		"gpu.intel.com/i915_monitoring": "", "gpu.intel.com/xe_monitoring": "",
		"amd.com/cpx": "", "amd.com/xilinx_u250": "", "habana.ai/gaudi": "", "aws.amazon.com/neuron": "", "aws.amazon.com/neuroncore": "",
		"google.com/tpu": "", "cpu": "",
	} {
		if got := gpuVendorOf(corev1.ResourceName(name)); got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
}

// Each company's GPUs are counted by the same rules as NVIDIA's (in use = kubectl describe node's Allocated resources,
// waiting apart, a pod's request by PodRequests), each node and pod says whose GPUs it has, and a node's model, memory
// and driver are its company's labels: AMD's labeller (the value, or the values it writes after the name when the
// node's GPUs differ), Intel's product label. A node of two companies counts both; a node of other accelerators is
// no GPU node.
func TestGPUDashboard_CountsEveryVendorsGPUs(t *testing.T) {
	api := &listAPI{
		pods: []corev1.Pod{
			gpuPodObj("nv-one", "nv", corev1.PodRunning, nil, gpuBox("app", "nvidia.com/gpu", "1")),
			gpuPodObj("amd-two", "amd", corev1.PodRunning, nil, gpuBox("app", "amd.com/gpu", "2")),
			gpuPodObj("amd-part", "amd-cpx", corev1.PodRunning, nil, gpuBox("app", "amd.com/cpx_nps4", "3")),
			// the millicores and the monitoring resource are not GPUs
			gpuPodObj("intel-one", "intel", corev1.PodRunning, nil, gpuBox("app", "gpu.intel.com/i915", "1", "gpu.intel.com/millicores", "500", "gpu.intel.com/i915_monitoring", "1")),
			gpuPodObj("intel-millicores-only", "intel", corev1.PodRunning, nil, gpuBox("app", "gpu.intel.com/millicores", "100")),
			gpuPodObj("two-vendors", "mixed", corev1.PodRunning, nil, gpuBox("app", "nvidia.com/gpu", "1", "gpu.intel.com/i915", "1")),
			gpuPodObj("amd-waiting", "", corev1.PodPending, nil, gpuBox("app", "amd.com/gpu", "1")),
			gpuPodObj("amd-done", "amd", corev1.PodSucceeded, nil, gpuBox("app", "amd.com/gpu", "4")),
			gpuPodObj("gaudi", "accel", corev1.PodRunning, nil, gpuBox("app", "habana.ai/gaudi", "1")),
		},
		objects: map[string]any{"/api/v1/nodes": corev1.NodeList{Items: []corev1.Node{
			gpuNodeObj("nv", corev1.ConditionTrue, false, map[string]string{"nvidia.com/gpu.product": "NVIDIA-H100-80GB-HBM3", "nvidia.com/gpu.memory": "81559", "nvidia.com/cuda.driver-version.full": "580.95.05"},
				gpuList("nvidia.com/gpu", "4", "nvidia.com/mig-1g.10gb", "2")),
			gpuNodeObj("amd", corev1.ConditionFalse, false, map[string]string{"amd.com/gpu.product-name": "AMD_Instinct_MI300X", "amd.com/gpu.vram": "192G", "amd.com/gpu.driver-version": "6.12.12"},
				gpuList("cpu", "64", "amd.com/gpu", "8")),
			// mixed strategy, two partition kinds; the labeller writes one label per product when they differ
			gpuNodeObj("amd-cpx", corev1.ConditionTrue, false, map[string]string{"beta.amd.com/gpu.product-name.AMD_Instinct_MI325X": "1", "beta.amd.com/gpu.product-name.AMD_Instinct_MI300X": "1", "beta.amd.com/gpu.vram": "192G"},
				gpuList("amd.com/cpx_nps4", "16", "amd.com/spx_nps1", "1")),
			gpuNodeObj("intel", corev1.ConditionTrue, false, map[string]string{"gpu.intel.com/product": "Max_1550", "gpu.intel.com/family": "Max_Series"},
				gpuList("gpu.intel.com/i915", "2", "gpu.intel.com/xe", "1", "gpu.intel.com/millicores", "3000", "gpu.intel.com/memory.max", "68719476736", "gpu.intel.com/tiles", "4", "gpu.intel.com/monitoring", "1", "gpu.intel.com/i915_monitoring", "1")),
			gpuNodeObj("mixed", corev1.ConditionTrue, false, map[string]string{"nvidia.com/gpu.product": "NVIDIA-L4"},
				gpuList("nvidia.com/gpu", "1", "gpu.intel.com/i915", "1")),
			gpuNodeObj("accel", corev1.ConditionTrue, false, nil, gpuList("habana.ai/gaudi", "8", "aws.amazon.com/neuron", "2")),
		}}},
	}
	res, err := api.serve(t).GetGPUDashboard(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// capacity nv 6 + amd 8 + amd-cpx 17 + intel 3 + mixed 2; in use nv-one 1, amd-two 2, amd-part 3, intel-one 1,
	// two-vendors 2 (amd-done ended); amd-waiting waits
	got := map[string]interface{}{"capacity": res["total_gpu_capacity"], "allocatable": res["total_gpu_allocatable"], "used": res["total_gpu_used"], "waiting": res["total_gpu_waiting"]}
	want := map[string]interface{}{"capacity": 36, "allocatable": 36, "used": 9, "waiting": 1}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %v, want %v (all %v)", k, got[k], v, got)
		}
	}
	wantVendors := []map[string]interface{}{
		{"vendor": "NVIDIA", "capacity": 7, "allocatable": 7, "used": 2, "waiting": 0},
		{"vendor": "AMD", "capacity": 25, "allocatable": 25, "used": 5, "waiting": 1},
		{"vendor": "Intel", "capacity": 4, "allocatable": 4, "used": 2, "waiting": 0},
	}
	if v := res["vendors"]; !reflect.DeepEqual(v, wantVendors) {
		t.Errorf("vendors %v, want %v", v, wantVendors)
	}

	nodes := res["gpu_nodes"].([]map[string]interface{})
	if len(nodes) != 5 {
		t.Fatalf("GPU nodes %d (the accelerator node is none): %v", len(nodes), nodes)
	}
	for name, w := range map[string]map[string]interface{}{
		"nv":      {"gpu_capacity": 6, "gpu_used": 1, "gpu_model": "NVIDIA-H100-80GB-HBM3", "gpu_memory": "81559", "driver_version": "580.95.05", "status": "Ready"},
		"amd":     {"gpu_capacity": 8, "gpu_used": 2, "gpu_model": "AMD_Instinct_MI300X", "gpu_memory": "192G", "driver_version": "6.12.12", "status": "NotReady"},
		"amd-cpx": {"gpu_capacity": 17, "gpu_used": 3, "gpu_model": "AMD_Instinct_MI300X, AMD_Instinct_MI325X", "gpu_memory": "192G", "driver_version": nil, "status": "Ready"},
		"intel":   {"gpu_capacity": 3, "gpu_used": 1, "gpu_model": "Max_1550", "gpu_memory": nil, "driver_version": nil, "status": "Ready"},
		"mixed":   {"gpu_capacity": 2, "gpu_used": 2, "gpu_model": "NVIDIA-L4", "gpu_memory": nil, "driver_version": nil, "status": "Ready"},
	} {
		n := gpuRow(t, nodes, name)
		for k, v := range w {
			if n[k] != v {
				t.Errorf("node %s %s: %v, want %v (%v)", name, k, n[k], v, n)
			}
		}
	}
	if v := gpuRow(t, nodes, "mixed")["gpu_vendors"]; !reflect.DeepEqual(v, []map[string]interface{}{
		{"vendor": "NVIDIA", "capacity": 1, "allocatable": 1, "used": 1, "model": "NVIDIA-L4"},
		{"vendor": "Intel", "capacity": 1, "allocatable": 1, "used": 1},
	}) {
		t.Errorf("mixed node's companies %v", v)
	}
	if v := gpuRow(t, nodes, "amd")["gpu_vendors"]; !reflect.DeepEqual(v, []map[string]interface{}{
		{"vendor": "AMD", "capacity": 8, "allocatable": 8, "used": 2, "model": "AMD_Instinct_MI300X", "memory": "192G", "driver_version": "6.12.12"},
	}) {
		t.Errorf("amd node's companies %v", v)
	}

	pods := res["gpu_pods"].([]map[string]interface{})
	if len(pods) != 7 {
		t.Fatalf("GPU pods %d (millicores only and Gaudi are none): %v", len(pods), pods)
	}
	for name, w := range map[string][]map[string]interface{}{
		"intel-one":   {{"vendor": "Intel", "requested": 1}},
		"amd-part":    {{"vendor": "AMD", "requested": 3}},
		"two-vendors": {{"vendor": "NVIDIA", "requested": 1}, {"vendor": "Intel", "requested": 1}},
		"amd-waiting": {{"vendor": "AMD", "requested": 1}},
	} {
		r := gpuRow(t, pods, name)
		if !reflect.DeepEqual(r["gpu_vendors"], w) || r["gpu_requested"] != sumRequested(w) {
			t.Errorf("pod %s: %v, want %v", name, r, w)
		}
	}
}

func sumRequested(vendors []map[string]interface{}) int {
	n := 0
	for _, v := range vendors {
		n += v["requested"].(int)
	}
	return n
}

// Each company with GPUs or a device plugin found gets its plugin's state: found under one of its documented names
// (AMD's GPU Operator, Intel's kustomize base) or not found; a company with neither is not listed.
func TestGPUDashboard_DevicePluginPerVendor(t *testing.T) {
	ds := func(ns, name string, desired, ready int32) appsv1.DaemonSet {
		return appsv1.DaemonSet{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, Status: appsv1.DaemonSetStatus{DesiredNumberScheduled: desired, NumberReady: ready, NumberAvailable: ready}}
	}
	api := &listAPI{objects: map[string]any{
		"/api/v1/nodes": corev1.NodeList{Items: []corev1.Node{
			gpuNodeObj("nv", corev1.ConditionTrue, false, nil, gpuList("nvidia.com/gpu", "1")),
			gpuNodeObj("amd", corev1.ConditionTrue, false, nil, gpuList("amd.com/gpu", "2")),
		}},
		"/apis/apps/v1/namespaces/kube-amd-gpu/daemonsets/gpu-operator-device-plugin": ds("kube-amd-gpu", "gpu-operator-device-plugin", 2, 1),
		// a plugin that has registered no GPU yet is still told
		"/apis/apps/v1/namespaces/default/daemonsets/intel-gpu-plugin": ds("default", "intel-gpu-plugin", 1, 1),
	}}
	res, err := api.serve(t).GetGPUDashboard(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []map[string]interface{}{
		{"vendor": "NVIDIA", "found": false},
		{"vendor": "AMD", "found": true, "name": "gpu-operator-device-plugin", "namespace": "kube-amd-gpu", "desired": int32(2), "ready": int32(1), "available": int32(1)},
		{"vendor": "Intel", "found": true, "name": "intel-gpu-plugin", "namespace": "default", "desired": int32(1), "ready": int32(1), "available": int32(1)},
	}
	if got := res["device_plugins"]; !reflect.DeepEqual(got, want) {
		t.Errorf("device plugins %v, want %v", got, want)
	}

	none, err := (&listAPI{objects: map[string]any{"/api/v1/nodes": corev1.NodeList{}}}).serve(t).GetGPUDashboard(context.Background())
	if err != nil || len(none["device_plugins"].([]map[string]interface{})) != 0 {
		t.Errorf("no GPU and no plugin: %v %v", none["device_plugins"], err)
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
