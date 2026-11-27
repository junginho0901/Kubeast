package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func ago(d time.Duration) metav1.Time { return metav1.NewTime(issuesNow.Add(-d)) }

func readyCond(status corev1.ConditionStatus, since time.Duration) []corev1.PodCondition {
	return []corev1.PodCondition{{Type: corev1.PodReady, Status: status, LastTransitionTime: ago(since)}}
}

// looping is a container waiting to be started again: its last run was from lastRun to end ago.
func looping(restarts int32, lastRun, end time.Duration) corev1.ContainerStatus {
	return corev1.ContainerStatus{Name: "main", RestartCount: restarts,
		State:                corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
		LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", StartedAt: ago(lastRun), FinishedAt: ago(end)}}}
}

func runningSince(restarts int32, since time.Duration, ready bool) corev1.ContainerStatus {
	cs := corev1.ContainerStatus{Name: "main", RestartCount: restarts, Ready: ready,
		State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: ago(since)}}}
	if restarts > 0 {
		cs.LastTerminationState = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", StartedAt: ago(since + time.Hour), FinishedAt: ago(since)}}
	}
	return cs
}

func TestPodSinceOfSaysFromWhenOnlyWhatThePodShows(t *testing.T) {
	pod := func(phase corev1.PodPhase, conds []corev1.PodCondition, cs ...corev1.ContainerStatus) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "a", CreationTimestamp: ago(3 * time.Hour)},
			Status: corev1.PodStatus{Phase: phase, Conditions: conds, ContainerStatuses: cs}}
	}
	ended := func(d time.Duration) corev1.ContainerStatus {
		return corev1.ContainerStatus{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", FinishedAt: ago(d)}}}
	}
	for _, c := range []struct {
		name  string
		pod   *corev1.Pod
		since time.Duration // 0: not known
		loops bool
	}{
		{"pending since it was made", pod(corev1.PodPending, nil), 3 * time.Hour, false},
		{"failed since its last container ended", pod(corev1.PodFailed, nil, ended(50*time.Minute), ended(20*time.Minute)), 20 * time.Minute, false},
		{"not ready, never restarted", pod(corev1.PodRunning, readyCond(corev1.ConditionFalse, 7*time.Minute), runningSince(0, 3*time.Hour, false)), 7 * time.Minute, false},
		{"its node is gone", pod(corev1.PodRunning, readyCond(corev1.ConditionUnknown, 9*time.Minute), runningSince(0, 3*time.Hour, true)), 9 * time.Minute, false},
		// Ready comes and goes with the container, so its last transition is the last crash and not the first
		{"a crash loop that is ready while it runs", pod(corev1.PodRunning, readyCond(corev1.ConditionFalse, 4*time.Minute), looping(7, 4*time.Minute+3*time.Second, 4*time.Minute)), 0, true},
		// never ready: the condition was False before the last run began
		{"a crash loop that is never ready", pod(corev1.PodRunning, readyCond(corev1.ConditionFalse, 2*time.Hour), looping(20, 6*time.Minute, 5*time.Minute)), 2 * time.Hour, false},
		{"restarted long ago, not ready now in the same run", pod(corev1.PodRunning, readyCond(corev1.ConditionFalse, 10*time.Minute), runningSince(3, 2*time.Hour, false)), 10 * time.Minute, false},
		{"restarted a moment ago and not ready yet", pod(corev1.PodRunning, readyCond(corev1.ConditionFalse, 2*time.Minute), runningSince(1, time.Minute, false)), 0, true},
		{"ready, restarted", pod(corev1.PodRunning, readyCond(corev1.ConditionTrue, time.Minute), runningSince(2, time.Minute, true)), 0, true},
		{"ready, never restarted", pod(corev1.PodRunning, readyCond(corev1.ConditionTrue, time.Hour), runningSince(0, time.Hour, true)), 0, false},
		// the other container is well: it does not decide
		{"one container down, one restarted long ago and ready", pod(corev1.PodRunning, readyCond(corev1.ConditionFalse, 8*time.Minute), runningSince(0, 3*time.Hour, false), runningSince(4, time.Hour, true)), 8 * time.Minute, false},
		{"no status at all", pod(corev1.PodRunning, nil), 0, false},
	} {
		got := podSinceOf(c.pod)
		var want time.Time
		if c.since > 0 {
			want = issuesNow.Add(-c.since)
		}
		if !got.at.Equal(want) || got.loops != c.loops {
			t.Errorf("%s: %v loops %v, want %v loops %v", c.name, got.at, got.loops, want, c.loops)
		}
	}
}

func TestAnEventRunIsDatedOnlyWhenItKeptComing(t *testing.T) {
	run := func(first, last time.Duration, count int) eventRun {
		return eventRun{first: issuesNow.Add(-first), last: issuesNow.Add(-last), count: count}
	}
	for _, c := range []struct {
		name string
		run  eventRun
		want bool
	}{
		{"a crash loop of 14 minutes, about one a minute", run(15*time.Minute, time.Minute, 15), true},
		{"an hour of it, as recorded", run(66*time.Minute, time.Minute, 58), true},
		{"seven hours", run(7*time.Hour, 4*time.Minute, 380), true},
		{"an hour's run five hours ago and one that began 10 minutes ago", run(5*time.Hour, time.Minute, 58+10), false},
		{"a run two days ago and another that began 10 minutes ago", run(48*time.Hour, time.Minute, 60+10), false},
		{"three at the start, well for 40 minutes, failing for 5", run(45*time.Minute, time.Minute, 3+6), false},
		{"once, at the start", run(15*time.Minute, 15*time.Minute, 1), false},
		{"ended half an hour ago", run(time.Hour, 30*time.Minute, 30), false},
	} {
		got := c.run.since(issuesNow)
		if c.want != !got.IsZero() || (c.want && !got.Equal(c.run.first)) {
			t.Errorf("%s: %v", c.name, got)
		}
	}
}

func backOffEvent(uid, pod string, first, last time.Duration, count int32) corev1.Event {
	return corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: pod + "." + first.String(), Namespace: "a"}, Type: corev1.EventTypeWarning, Reason: backOffReason,
		Message:        "Back-off restarting failed container main in pod " + pod,
		InvolvedObject: corev1.ObjectReference{Kind: "Pod", Namespace: "a", Name: pod, UID: types.UID(uid), APIVersion: "v1"},
		FirstTimestamp: ago(first), LastTimestamp: ago(last), Count: count}
}

func TestBackOffsAreDatedByTheContainerThatBeganLast(t *testing.T) {
	var b backOffs
	for _, e := range []corev1.Event{
		backOffEvent("one", "one-0", 20*time.Minute, time.Minute, 20),
		backOffEvent("two", "two-0", 3*time.Hour, 2*time.Minute, 170), backOffEvent("two", "two-0", 8*time.Minute, time.Minute, 9),
		backOffEvent("half", "half-0", 20*time.Minute, time.Minute, 20), backOffEvent("half", "half-0", 10*time.Hour, time.Minute, 4),
		backOffEvent("past", "past-0", 3*time.Hour, 2*time.Hour, 60), backOffEvent("past", "past-0", 10*time.Minute, time.Minute, 11),
		backOffEvent("sts-old", "sts-0", 2*time.Hour, time.Minute, 110), // the pod of that name before
		// another reason, and another kind, of the same UID
		{Reason: "Unhealthy", InvolvedObject: corev1.ObjectReference{Kind: "Pod", UID: "one"}, FirstTimestamp: ago(3 * time.Minute), LastTimestamp: ago(time.Minute), Count: 12},
		{Reason: backOffReason, InvolvedObject: corev1.ObjectReference{Kind: "Job", UID: "one"}, FirstTimestamp: ago(4 * time.Minute), LastTimestamp: ago(time.Minute), Count: 12},
	} {
		e := e
		b.add(&e)
	}
	for uid, want := range map[string]time.Duration{"one": 20 * time.Minute, "two": 8 * time.Minute, "half": 0, "past": 10 * time.Minute, "sts-new": 0} {
		got := b.since(types.UID(uid), issuesNow)
		if (want == 0) != got.IsZero() || (want > 0 && !got.Equal(issuesNow.Add(-want))) {
			t.Errorf("%s: %v, want %v ago", uid, got, want)
		}
	}
}

func TestWorkloadIssueID(t *testing.T) {
	controller := true
	pod := func(kind, name string, labels map[string]string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "a", Labels: labels,
			OwnerReferences: []metav1.OwnerReference{{Kind: kind, Name: name, Controller: &controller}}}}
	}
	for want, p := range map[string]*corev1.Pod{
		"Deployment/a/web-api":    pod("ReplicaSet", "web-api-6d5f8c7b9", map[string]string{"pod-template-hash": "6d5f8c7b9"}),
		"ReplicaSet/a/web-abc":    pod("ReplicaSet", "web-abc", nil),
		"StatefulSet/a/db":        pod("StatefulSet", "db", nil),
		"DaemonSet/a/agent":       pod("DaemonSet", "agent", nil),
		"":                        {ObjectMeta: metav1.ObjectMeta{Namespace: "a"}},
		"ReplicaSet/a/other-rs-x": pod("ReplicaSet", "other-rs-x", map[string]string{"pod-template-hash": "y"}),
	} {
		if got := workloadIssueID(p); got != want {
			t.Errorf("%q, want %q", got, want)
		}
	}
}

// A workload is dated by the pod of it that went down last, not at all while one of them is not known, and a pod that
// restarted and runs does not count.
func TestFillSinceDatesAWorkloadByItsPods(t *testing.T) {
	pod := func(name, owner, reason string, at time.Duration) Issue {
		is := Issue{ID: "Pod/a/" + name, Kind: "Pod", Namespace: "a", Name: name, Severity: severityCritical, Reason: reason, pod: podSince{owner: owner}}
		if at > 0 {
			is.pod.at = issuesNow.Add(-at)
		}
		return is
	}
	dep := func(name string) Issue {
		return Issue{ID: "Deployment/a/" + name, Kind: "Deployment", Namespace: "a", Name: name, Severity: severityWarning, Reason: "Unavailable"}
	}
	issues := []Issue{
		pod("web-1", "Deployment/a/web", "Phase Pending", 3*time.Hour), pod("web-2", "Deployment/a/web", "Ready 0/1", 6*time.Minute), dep("web"),
		pod("api-1", "Deployment/a/api", "Ready 0/1", time.Hour), pod("api-2", "Deployment/a/api", "CrashLoopBackOff", 0), dep("api"),
		pod("job-1", "Deployment/a/job", "Ready 0/1", time.Hour), pod("job-2", "Deployment/a/job", restartedReason+"Error", 0), dep("job"),
		dep("none"),
		pod("backup-1", "Job/a/backup", "Phase Failed, Error", 2*time.Hour),
		{ID: "Job/a/backup", Kind: "Job", Namespace: "a", Name: "backup", Severity: severityWarning, Reason: "Failed"},
		{ID: "Widget.example.com/a/w", Kind: "Widget", Namespace: "a", Name: "w", Severity: severityWarning, Reason: "Sync"},
		{ID: "Widget.example.com/a/once", Kind: "Widget", Namespace: "a", Name: "once", Severity: severityWarning, Reason: "Sync"},
	}
	own := issueIDs(issues[:12])
	event := func(name string, first time.Duration, count int32) m {
		return m{"type": "Warning", "reason": "Sync", "count": count, "first_timestamp": iso(issuesNow.Add(-first)), "last_timestamp": iso(issuesNow.Add(-time.Minute)),
			"involved_object": m{"kind": "Widget", "api_version": "example.com/v1", "namespace": "a", "name": name}}
	}
	fillSince(issues, own, toMaps([]m{event("w", 30*time.Minute, 60), event("once", 30*time.Minute, 2)}), &backOffs{}, issuesNow)
	want := map[string]time.Duration{
		"Deployment/a/web": 6 * time.Minute, "Deployment/a/api": 0, "Deployment/a/job": time.Hour, "Deployment/a/none": 0, "Job/a/backup": 2 * time.Hour,
		"Pod/a/web-1": 3 * time.Hour, "Pod/a/api-2": 0, "Widget.example.com/a/w": 30 * time.Minute, "Widget.example.com/a/once": 0,
	}
	for id, ago := range want {
		text := ""
		if ago > 0 {
			text = iso(issuesNow.Add(-ago))
		}
		if got := findIssue(t, issues, id).Since; got != text {
			t.Errorf("%s since %q, want %q", id, got, text)
		}
	}
}

// issuesAPI answers one namespace: notifier crash-looping since its Deployment was made, catalog, whose readiness failed once
// as it started and is ready, and a Widget whose Warning event keeps coming.
func issuesAPI(t *testing.T) (*Service, func() []string) {
	t.Helper()
	controller, replicas := true, int32(1)
	pod := func(name, deploy string, st corev1.PodStatus) corev1.Pod {
		return corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "a", UID: types.UID(name), CreationTimestamp: ago(16 * time.Minute),
			Labels:          map[string]string{"pod-template-hash": "545d4cb75"},
			OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: deploy + "-545d4cb75", Controller: &controller}}},
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "main"}}}, Status: st}
	}
	pods := []corev1.Pod{
		pod("notifier-545d4cb75-xpb7k", "notifier", corev1.PodStatus{Phase: corev1.PodRunning, Conditions: readyCond(corev1.ConditionFalse, 4*time.Minute),
			ContainerStatuses: []corev1.ContainerStatus{looping(7, 4*time.Minute+3*time.Second, 4*time.Minute)}}),
		pod("catalog-545d4cb75-dg69q", "catalog", corev1.PodStatus{Phase: corev1.PodRunning, Conditions: readyCond(corev1.ConditionTrue, 15*time.Minute),
			ContainerStatuses: []corev1.ContainerStatus{runningSince(0, 16*time.Minute, true)}}),
	}
	unhealthy := backOffEvent("catalog-545d4cb75-dg69q", "catalog-545d4cb75-dg69q", 15*time.Minute+30*time.Second, 15*time.Minute+30*time.Second, 1)
	unhealthy.Reason, unhealthy.Message = "Unhealthy", "Readiness probe failed: connect: connection refused"
	widget := backOffEvent("w", "w", 30*time.Minute, time.Minute, 60)
	widget.Reason, widget.InvolvedObject.Kind, widget.InvolvedObject.APIVersion = "SyncFailed", "Widget", "example.com/v1"
	events := []corev1.Event{backOffEvent("notifier-545d4cb75-xpb7k", "notifier-545d4cb75-xpb7k", 15*time.Minute+50*time.Second, 90*time.Second, 15), unhealthy, widget}
	deployments := []appsv1.Deployment{{ObjectMeta: metav1.ObjectMeta{Name: "notifier", Namespace: "a"}, Spec: appsv1.DeploymentSpec{Replicas: &replicas}}}
	var mu sync.Mutex
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked = append(asked, r.URL.String())
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/pods"):
			_ = json.NewEncoder(w).Encode(corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, Items: pods})
		case strings.HasSuffix(r.URL.Path, "/events"):
			_ = json.NewEncoder(w).Encode(corev1.EventList{TypeMeta: metav1.TypeMeta{Kind: "EventList", APIVersion: "v1"}, Items: events})
		case strings.HasSuffix(r.URL.Path, "/deployments"):
			_ = json.NewEncoder(w).Encode(appsv1.DeploymentList{TypeMeta: metav1.TypeMeta{Kind: "DeploymentList", APIVersion: "apps/v1"}, Items: deployments})
		default:
			_, _ = w.Write([]byte(`{"items":[]}`))
		}
	}))
	t.Cleanup(srv.Close)
	k, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: k})
	return s, func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := append([]string{}, asked...)
		asked = nil
		sort.Strings(out)
		return out
	}
}

// Asked for, the failing pod and its workload say since when, and nothing more is read; not asked for, the answer is the
// bytes it was. The rest of a row is the same either way.
func TestIssuesSayFromWhenOnlyWhenAsked(t *testing.T) {
	for _, namespace := range []string{"", "a"} {
		s, asked := issuesAPI(t)
		read := func(since bool) (string, []Issue) {
			t.Helper()
			issues, err := s.CollectIssues(context.Background(), IssuesOptions{Now: issuesNow, Window: time.Hour, Namespace: namespace, Since: since})
			if err != nil {
				t.Fatal(err)
			}
			out, err := json.Marshal(issues)
			if err != nil {
				t.Fatal(err)
			}
			return string(out), issues
		}
		off, _ := read(false)
		readOff := asked()
		on, issues := read(true)
		if readOn := asked(); !reflect.DeepEqual(readOn, readOff) {
			t.Fatalf("with since it reads %v, without %v", readOn, readOff)
		}
		if strings.Contains(off, "since") {
			t.Fatalf("not asked for: %s", off)
		}
		began := iso(issuesNow.Add(-15*time.Minute - 50*time.Second))
		for id, want := range map[string]string{"Pod/a/notifier-545d4cb75-xpb7k": began, "Deployment/a/notifier": began, "Pod/a/catalog-545d4cb75-dg69q": "",
			"Widget.example.com/a/w": iso(issuesNow.Add(-30 * time.Minute))} {
			if got := findIssue(t, issues, id).Since; got != want {
				t.Errorf("namespace %q: %s since %q, want %q", namespace, id, got, want)
			}
		}
		if without := regexp.MustCompile(`,"since":"[^"]+"`).ReplaceAllString(on, ""); without != off {
			t.Fatalf("namespace %q: the rest changed\n%s\n%s", namespace, without, off)
		}
	}
}
