package k8s

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// A box of the Resource Graph says what the lists say: the workload lists' summary
// status, the Pods list's Status, and how the lists draw it (Health) — so the
// Issues filter keeps a CrashLoopBackOff pod, a short StatefulSet or a failed Job.
func TestBuildWorkloadGraph_StatusesAreTheLists(t *testing.T) {
	meta := func(name string) metav1.ObjectMeta { return metav1.ObjectMeta{Namespace: "ns", Name: name} }
	n := func(v int32) *int32 { return &v }
	cond := func(t, s string, reason string) appsv1.DeploymentCondition {
		return appsv1.DeploymentCondition{Type: appsv1.DeploymentConditionType(t), Status: corev1.ConditionStatus(s), Reason: reason}
	}
	deploys := []appsv1.Deployment{
		{ObjectMeta: meta("dep-ok"), Spec: appsv1.DeploymentSpec{Replicas: n(2)}, Status: appsv1.DeploymentStatus{ReadyReplicas: 2,
			Conditions: []appsv1.DeploymentCondition{cond("Available", "True", "MinimumReplicasAvailable")}}},
		{ObjectMeta: meta("dep-stuck"), Spec: appsv1.DeploymentSpec{Replicas: n(1)}, Status: appsv1.DeploymentStatus{
			Conditions: []appsv1.DeploymentCondition{cond("Available", "False", "MinimumReplicasUnavailable"), cond("Progressing", "False", "ProgressDeadlineExceeded")}}},
	}
	sts := []appsv1.StatefulSet{
		{ObjectMeta: meta("sts-short"), Spec: appsv1.StatefulSetSpec{Replicas: n(3)}, Status: appsv1.StatefulSetStatus{ReadyReplicas: 1, AvailableReplicas: 1}},
		{ObjectMeta: meta("sts-idle"), Spec: appsv1.StatefulSetSpec{Replicas: n(0)}},
	}
	dss := []appsv1.DaemonSet{{ObjectMeta: meta("ds-down"), Status: appsv1.DaemonSetStatus{DesiredNumberScheduled: 2}}}
	rss := []appsv1.ReplicaSet{{ObjectMeta: meta("rs-ok"), Spec: appsv1.ReplicaSetSpec{Replicas: n(2)}, Status: appsv1.ReplicaSetStatus{Replicas: 2, ReadyReplicas: 2, AvailableReplicas: 2}}}
	jobs := []batchv1.Job{
		{ObjectMeta: meta("job-failed"), Status: batchv1.JobStatus{Failed: 1, Conditions: []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}}},
		// one of three completions done: still running, not "Succeeded"
		{ObjectMeta: meta("job-going"), Status: batchv1.JobStatus{Succeeded: 1, Active: 1}},
	}
	pod := func(name string, phase corev1.PodPhase, cs corev1.ContainerStatus) corev1.Pod {
		return corev1.Pod{ObjectMeta: meta(name), Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
			Status: corev1.PodStatus{Phase: phase, ContainerStatuses: []corev1.ContainerStatus{cs}}}
	}
	pods := []corev1.Pod{
		pod("pod-crash", corev1.PodRunning, corev1.ContainerStatus{Name: "app", RestartCount: 4,
			State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}}),
		pod("pod-unready", corev1.PodRunning, corev1.ContainerStatus{Name: "app", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}),
		pod("pod-done", corev1.PodSucceeded, corev1.ContainerStatus{Name: "app", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed"}}}),
		pod("pod-going", corev1.PodRunning, corev1.ContainerStatus{Name: "app", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}),
	}
	gone := metav1.Now()
	pods[3].DeletionTimestamp = &gone
	res := &rgResources{deployments: deploys, statefulSets: sts, daemonSets: dss, replicaSets: rss, jobs: jobs}
	for i := range pods {
		res.pods = append(res.pods, toRGPod(&pods[i]))
	}
	nodes := map[string]rgNode{}
	buildWorkloadGraph(res, nodes, func(n rgNode) { nodes[n.ID] = n }, nil, func(string) bool { return true })

	// what each list sends for the same object
	listStatus := map[string]string{}
	for i := range deploys {
		listStatus[rgNodeID("Deployment", "ns", deploys[i].Name)] = formatDeploymentDetail(&deploys[i])["status"].(string)
	}
	for i := range sts {
		listStatus[rgNodeID("StatefulSet", "ns", sts[i].Name)] = formatStatefulSetDetail(&sts[i])["status"].(string)
	}
	for i := range dss {
		listStatus[rgNodeID("DaemonSet", "ns", dss[i].Name)] = formatDaemonSetDetail(&dss[i])["status"].(string)
	}
	for i := range rss {
		listStatus[rgNodeID("ReplicaSet", "ns", rss[i].Name)] = formatReplicaSetDetail(&rss[i])["status"].(string)
	}
	for i := range jobs {
		listStatus[rgNodeID("Job", "ns", jobs[i].Name)] = formatJobDetail(&jobs[i])["status"].(string)
	}
	for i := range pods {
		s, _, _, _ := podListView(&pods[i])
		listStatus[rgNodeID("Pod", "ns", pods[i].Name)] = s
	}
	want := map[string]string{ // the box's status and health
		"Deployment/ns/dep-ok":     "Available ok",
		"Deployment/ns/dep-stuck":  "Failed error",
		"StatefulSet/ns/sts-short": "Degraded warn",
		"StatefulSet/ns/sts-idle":  "Idle ",
		"DaemonSet/ns/ds-down":     "Unavailable error",
		"ReplicaSet/ns/rs-ok":      "Healthy ok",
		"Job/ns/job-failed":        "Failed error",
		"Job/ns/job-going":         "Running ok",
		"Pod/ns/pod-crash":         "CrashLoopBackOff error",
		"Pod/ns/pod-unready":       "Running warn",
		"Pod/ns/pod-done":          "Completed ok",
		"Pod/ns/pod-going":         "Terminating warn",
	}
	for id, w := range want {
		got, ok := nodes[id]
		if !ok {
			t.Errorf("%s: no box", id)
			continue
		}
		if s := got.Status + " " + got.Health; s != w {
			t.Errorf("%s: box %q, want %q", id, s, w)
		}
		if got.Status != listStatus[id] {
			t.Errorf("%s: box says %q, its list %q", id, got.Status, listStatus[id])
		}
	}
	if got := nodes["Pod/ns/pod-unready"].Ready; got != "0/1" {
		t.Errorf("pod-unready READY = %q, want the Pods list's 0/1", got)
	}
	// the answer the page and the AI tool get carries the same status and health
	sent := map[string]string{}
	for _, m := range buildResourceGraphResponse(nodes, nil)["nodes"].([]map[string]interface{}) {
		health, _ := m["health"].(string)
		sent[m["id"].(string)] = m["status"].(string) + " " + health
	}
	for id, w := range want {
		if sent[id] != w {
			t.Errorf("%s: answer %q, want %q", id, sent[id], w)
		}
	}
}
