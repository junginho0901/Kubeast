package k8s

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// variedPod is bulkPod with the values a row carries changed by i: escaped and non-ASCII text, init and sidecar
// containers, ports, mounts, environment sources, security contexts, waiting and ended states, deletion, claims.
func variedPod(i int) corev1.Pod {
	app := []string{"a", "b", "c"}[i%3]
	phase := []corev1.PodPhase{corev1.PodRunning, corev1.PodPending, corev1.PodSucceeded, corev1.PodFailed, ""}[i%5]
	p := bulkPod(i, app, phase, "", "")
	if i%2 == 0 {
		p = bulkPod(i, app, phase, fmt.Sprintf("%dm", 10+i%7), fmt.Sprintf("%dMi", 16+i%5))
	}
	yes, uid := true, int64(1000+i%3)
	always := corev1.ContainerRestartPolicyAlways
	p.Labels["note"] = []string{"<b>&amp;</b>", "é한 ", `quote"back\slash`, ""}[i%4]
	p.CreationTimestamp = metav1.Date(2026, 11, 1, 0, i%60, i%60, 0, time.UTC)
	p.Spec.ServiceAccountName = []string{"", "sa-" + app}[i%2]
	p.Spec.PriorityClassName = []string{"", "high"}[i%2]
	c := &p.Spec.Containers[0]
	c.Image = "registry.example/app:1.<" + app + ">"
	c.Ports = []corev1.ContainerPort{{Name: "http", ContainerPort: int32(8000 + i%10), Protocol: corev1.ProtocolTCP}}
	c.VolumeMounts = []corev1.VolumeMount{{Name: "cfg", MountPath: "/etc/cfg", ReadOnly: i%2 == 0}}
	c.Env = make([]corev1.EnvVar, i%4)
	c.EnvFrom = []corev1.EnvFromSource{{Prefix: "P_", ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "cm-" + app}, Optional: &yes}}}
	c.SecurityContext = &corev1.SecurityContext{RunAsUser: &uid, ReadOnlyRootFilesystem: &yes, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}}
	if i%3 == 0 {
		c.Command, c.Args = []string{"/bin/app"}, []string{"--flag=<x>"}
		p.Spec.InitContainers = []corev1.Container{{Name: "init", Image: "busybox"}, {Name: "proxy", Image: "envoy", RestartPolicy: &always}}
		p.Status.InitContainerStatuses = []corev1.ContainerStatus{
			{Name: "init", Ready: true, State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed", ExitCode: 0}}},
			{Name: "proxy", Ready: true, Started: &yes, RestartCount: int32(i % 4), State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.Date(2026, 11, 1, 0, 1, 0, 0, time.UTC)}}},
		}
	}
	state := corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.Date(2026, 11, 1, 0, 2, 0, 0, time.UTC)}}
	if i%4 == 1 {
		state = corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff", Message: "back-off <5m0s> restarting & failed"}}
	}
	p.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "c", Ready: i%4 != 1, RestartCount: int32(i % 9), State: state,
		LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137}}}}
	p.Status.PodIP = fmt.Sprintf("10.0.%d.%d", i/250, i%250)
	if i%7 == 0 {
		gone := metav1.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
		p.DeletionTimestamp = &gone
	}
	if i%11 == 0 {
		claim, tmpl := "gpu-claim", "gpu-template"
		p.Spec.ResourceClaims = []corev1.PodResourceClaim{{Name: "gpu", ResourceClaimName: &claim}, {Name: "gpu2", ResourceClaimTemplateName: &tmpl}}
	}
	p.Spec.Volumes = []corev1.Volume{{Name: "cfg", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: "s-" + app}}}}
	return p
}

// The whole pods answer is byte for byte the JSON of GetPods' rows as json.Marshal writes them, with response.JSON's
// newline: over page edges, with a label selector and with none matching.
func TestPodsJSONIsTheRowsAsTheyWereWritten(t *testing.T) {
	api := &listAPI{}
	for i := range 1001 {
		api.pods = append(api.pods, variedPod(i))
	}
	api.pods[0].Status.Message = "\x00control\tand\nlines"
	api.pods[1].Spec.Containers[0].Resources.Limits = corev1.ResourceList{"nvidia.com/gpu": resource.MustParse("1")}
	s := api.serve(t)
	ctx := context.Background()
	for _, selector := range []string{"", "app=a", "app=none"} {
		rows, err := s.GetPods(ctx, "bulk", selector)
		if err != nil {
			t.Fatal(err)
		}
		want, err := json.Marshal(rows)
		if err != nil {
			t.Fatal(err)
		}
		want = append(want, '\n')
		got, err := s.GetPodsJSON(ctx, "bulk", selector)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			at := 0
			for at < min(len(got), len(want)) && got[at] == want[at] {
				at++
			}
			t.Errorf("selector %q: %d bytes, want %d; first difference at %d: %q, want %q", selector, len(got), len(want), at,
				got[max(0, at-40):min(len(got), at+40)], want[max(0, at-40):min(len(want), at+40)])
		}
		t.Logf("selector %q: %d rows, %d bytes", selector, len(rows), len(got))
	}
}
