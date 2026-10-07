package k8s

import (
	"testing"
	"time"
)

type m = map[string]interface{}

var issuesNow = time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)

func iso(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func findIssue(t *testing.T, issues []Issue, id string) Issue {
	t.Helper()
	for _, is := range issues {
		if is.ID == id {
			return is
		}
	}
	t.Fatalf("issue %s not found in %+v", id, issues)
	return Issue{}
}

func TestIssuesFromPods(t *testing.T) {
	pods := []m{
		{"namespace": "a", "name": "crash", "phase": "Running", "ready": "0/1", "restart_count": int32(7),
			"containers": []m{{"state": m{"waiting": m{"reason": "CrashLoopBackOff"}}, "last_state": m{"terminated": m{"reason": "Error", "finished_at": iso(issuesNow.Add(-2 * time.Minute))}}}}},
		{"namespace": "a", "name": "notready", "phase": "Running", "ready": "1/2", "containers": []m{{"state": m{"running": m{}}}}},
		{"namespace": "a", "name": "pending", "phase": "Pending", "ready": "0/1", "containers": []m{{"state": m{"waiting": m{"reason": "ContainerCreating"}}}}},
		{"namespace": "a", "name": "failed", "phase": "Failed", "message": "evicted", "containers": []m{}},
		{"namespace": "a", "name": "once-x", "phase": "Failed", "owner_references": []m{{"kind": "Job", "name": "once"}},
			"containers": []m{{"state": m{"terminated": m{"reason": "Error", "exit_code": int32(1)}}}}},
		{"namespace": "a", "name": "done", "phase": "Succeeded", "containers": []m{{"state": m{"terminated": m{"reason": "Completed"}}}}},
		{"namespace": "a", "name": "recent", "phase": "Running", "ready": "1/1", "restart_count": int32(1),
			"containers": []m{{"state": m{"running": m{}}, "last_state": m{"terminated": m{"reason": "OOMKilled", "finished_at": iso(issuesNow.Add(-30 * time.Minute))}}}}},
		{"namespace": "a", "name": "yesterday", "phase": "Running", "ready": "1/1", "restart_count": int32(2),
			"containers": []m{{"state": m{"running": m{}}, "last_state": m{"terminated": m{"reason": "Error", "finished_at": iso(issuesNow.Add(-20 * time.Hour))}}}}},
		{"namespace": "a", "name": "old", "phase": "Running", "ready": "1/1", "restart_count": int32(3),
			"containers": []m{{"state": m{"running": m{}}, "last_state": m{"terminated": m{"reason": "Error", "finished_at": iso(issuesNow.Add(-3 * 24 * time.Hour))}}}}},
		{"namespace": "a", "name": "fine", "phase": "Running", "ready": "1/1", "containers": []m{{"state": m{"running": m{}}}}},
	}
	got := issuesFromPods(toMaps(pods), IssuesOptions{Now: issuesNow})
	want := map[string][2]string{
		"Pod/a/crash":     {severityCritical, "CrashLoopBackOff, Ready 0/1"},
		"Pod/a/notready":  {severityWarning, "Ready 1/2"},
		"Pod/a/pending":   {severityWarning, "Phase Pending, ContainerCreating"},
		"Pod/a/failed":    {severityCritical, "Phase Failed"},
		"Pod/a/once-x":    {severityWarning, "Phase Failed, Error"},
		"Pod/a/recent":    {severityWarning, "Restarted: OOMKilled"},
		"Pod/a/yesterday": {severityInfo, "Restarted: Error"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d issues, want %d: %+v", len(got), len(want), got)
	}
	for _, is := range got {
		w, ok := want[is.ID]
		if !ok {
			t.Errorf("unexpected issue %+v", is)
			continue
		}
		if is.Severity != w[0] || is.Reason != w[1] {
			t.Errorf("%s: got %s %q, want %s %q", is.ID, is.Severity, is.Reason, w[0], w[1])
		}
	}
	if is := findIssue(t, got, "Pod/a/crash"); is.Count != 7 {
		t.Errorf("crash count = %d, want 7", is.Count)
	}
	if is := findIssue(t, got, "Pod/a/failed"); is.Message != "evicted" {
		t.Errorf("failed message = %q", is.Message)
	}

	withHistory := issuesFromPods(toMaps(pods), IssuesOptions{Now: issuesNow, IncludeRestartHistory: true})
	if is := findIssue(t, withHistory, "Pod/a/old"); is.Severity != severityInfo || is.Count != 3 {
		t.Errorf("old restart with history: %+v", is)
	}
}

func TestIssuesFromNodes(t *testing.T) {
	nodes := []m{
		{"name": "n1", "conditions": []m{{"type": "Ready", "status": "True"}, {"type": "DiskPressure", "status": "True", "reason": "KubeletHasDiskPressure"}}},
		{"name": "n2", "conditions": []m{{"type": "Ready", "status": "Unknown", "reason": "NodeStatusUnknown", "message": "Kubelet stopped posting node status."}}},
		{"name": "n3", "conditions": []m{{"type": "Ready", "status": "True"}, {"type": "MemoryPressure", "status": "False"}}},
	}
	got := issuesFromNodes(toMaps(nodes))
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	if is := findIssue(t, got, "Node/n1/DiskPressure"); is.Severity != severityWarning || is.Reason != "DiskPressure" {
		t.Errorf("n1: %+v", is)
	}
	if is := findIssue(t, got, "Node/n2"); is.Severity != severityCritical || is.Reason != "NotReady" || is.Message != "NodeStatusUnknown Kubelet stopped posting node status." {
		t.Errorf("n2: %+v", is)
	}
}

func TestIssuesFromWorkloads(t *testing.T) {
	deployments := []m{
		{"namespace": "a", "name": "stuck", "replicas": int32(2), "available_replicas": int32(1), "progressing_reason": "ProgressDeadlineExceeded"},
		{"namespace": "a", "name": "half", "replicas": int32(2), "available_replicas": int32(1), "progressing_reason": ""},
		{"namespace": "a", "name": "down", "replicas": int32(1), "available_replicas": int32(0)},
		{"namespace": "a", "name": "scaled0", "replicas": int32(0), "available_replicas": int32(0)},
		{"namespace": "a", "name": "ok", "replicas": int32(3), "available_replicas": int32(3)},
	}
	statefulsets := []m{{"namespace": "a", "name": "db", "replicas": int32(3), "ready_replicas": int32(0)}}
	daemonsets := []m{{"namespace": "kube-system", "name": "proxy", "desired": int32(3), "ready": int32(2), "unavailable": int32(1)}}
	got := issuesFromWorkloads(toMaps(deployments), toMaps(statefulsets), toMaps(daemonsets))
	if len(got) != 5 {
		t.Fatalf("got %d: %+v", len(got), got)
	}
	if is := findIssue(t, got, "Deployment/a/stuck"); is.Severity != severityCritical || is.Reason != "ProgressDeadlineExceeded" || is.Message != "available 1/2" {
		t.Errorf("stuck: %+v", is)
	}
	if is := findIssue(t, got, "Deployment/a/half"); is.Severity != severityWarning || is.Reason != "Unavailable" {
		t.Errorf("half: %+v", is)
	}
	if is := findIssue(t, got, "Deployment/a/down"); is.Severity != severityCritical {
		t.Errorf("down: %+v", is)
	}
	if is := findIssue(t, got, "StatefulSet/a/db"); is.Severity != severityCritical || is.Message != "ready 0/3" {
		t.Errorf("db: %+v", is)
	}
	if is := findIssue(t, got, "DaemonSet/kube-system/proxy"); is.Severity != severityWarning || is.Message != "ready 2/3" {
		t.Errorf("proxy: %+v", is)
	}
}

func TestIssuesFromJobsAndCronJobs(t *testing.T) {
	jobs := []m{
		{"namespace": "a", "name": "boom", "status": "Failed", "failed": int32(4), "succeeded": int32(0), "active": int32(0)},
		{"namespace": "a", "name": "retry", "status": "Running", "failed": int32(1), "succeeded": int32(0), "active": int32(1)},
		{"namespace": "a", "name": "ok", "status": "Complete", "failed": int32(0), "succeeded": int32(1), "active": int32(0)},
	}
	cronjobs := []m{
		{"namespace": "a", "name": "nightly", "active": 0, "last_schedule": "2026-10-07T01:00:00Z", "last_successful": "2026-10-06T01:00:00Z"},
		{"namespace": "a", "name": "never", "active": 0, "last_schedule": "2026-10-07T01:00:00Z"},
		{"namespace": "a", "name": "running", "active": 1, "last_schedule": "2026-10-07T01:00:00Z"},
		{"namespace": "a", "name": "fine", "active": 0, "last_schedule": "2026-10-07T01:00:00Z", "last_successful": "2026-10-07T01:00:05Z"},
		{"namespace": "a", "name": "new", "active": 0},
	}
	got := issuesFromJobs(toMaps(jobs), toMaps(cronjobs))
	if len(got) != 4 {
		t.Fatalf("got %d: %+v", len(got), got)
	}
	if is := findIssue(t, got, "Job/a/boom"); is.Severity != severityWarning || is.Reason != "Failed" || is.Count != 4 {
		t.Errorf("boom: %+v", is)
	}
	if is := findIssue(t, got, "Job/a/retry"); is.Severity != severityInfo || is.Reason != "Retrying" {
		t.Errorf("retry: %+v", is)
	}
	if is := findIssue(t, got, "CronJob/a/nightly"); is.Reason != "LastRunNotSucceeded" || is.LastSeen != "2026-10-07T01:00:00Z" {
		t.Errorf("nightly: %+v", is)
	}
	if is := findIssue(t, got, "CronJob/a/never"); is.Message != "last schedule 2026-10-07T01:00:00Z, last success never" {
		t.Errorf("never: %+v", is)
	}
}

func TestIssuesFromHPAsAndPVCs(t *testing.T) {
	hpas := []m{
		{"namespace": "a", "name": "web", "max_replicas": int32(5), "current_replicas": int32(5), "desired_replicas": int32(5)},
		{"namespace": "a", "name": "api", "max_replicas": int32(5), "current_replicas": int32(2), "desired_replicas": int32(2)},
	}
	pvcs := []m{
		{"namespace": "a", "name": "data", "status": "Bound"},
		{"namespace": "a", "name": "wait", "status": "Pending"},
		{"namespace": "a", "name": "gone", "status": "Lost"},
	}
	got := append(issuesFromHPAs(toMaps(hpas)), issuesFromPVCs(toMaps(pvcs))...)
	if len(got) != 3 {
		t.Fatalf("got %d: %+v", len(got), got)
	}
	if is := findIssue(t, got, "HorizontalPodAutoscaler/a/web"); is.Severity != severityInfo || is.Message != "current 5, max 5" {
		t.Errorf("web: %+v", is)
	}
	if is := findIssue(t, got, "PersistentVolumeClaim/a/wait"); is.Severity != severityWarning || is.Reason != "Pending" {
		t.Errorf("wait: %+v", is)
	}
	if is := findIssue(t, got, "PersistentVolumeClaim/a/gone"); is.Severity != severityCritical {
		t.Errorf("gone: %+v", is)
	}
}

func TestMergeEvents(t *testing.T) {
	issues := []Issue{
		{ID: "Pod/a/web", Kind: "Pod", Namespace: "a", Name: "web", Severity: severityWarning, Reason: "Ready 0/1"},
		{ID: "Node/n1", Kind: "Node", Name: "n1", Severity: severityCritical, Reason: "NotReady"},
		{ID: "HorizontalPodAutoscaler/a/h", Kind: "HorizontalPodAutoscaler", Namespace: "a", Name: "h", Severity: severityInfo},
	}
	events := []m{
		{"type": "Warning", "reason": "Unhealthy", "message": "Readiness probe failed: 503", "count": int32(12), "last_timestamp": iso(issuesNow.Add(-5 * time.Minute)), "involved_object": m{"kind": "Pod", "namespace": "a", "name": "web"}},
		{"type": "Warning", "reason": "BackOff", "message": "older", "count": int32(3), "last_timestamp": iso(issuesNow.Add(-20 * time.Minute)), "involved_object": m{"kind": "Pod", "namespace": "a", "name": "web"}},
		{"type": "Warning", "reason": "FailedScheduling", "message": "0/3 nodes are available", "count": int32(1), "last_timestamp": iso(issuesNow.Add(-10 * time.Minute)), "involved_object": m{"kind": "Pod", "namespace": "a", "name": "orphan"}},
		{"type": "Warning", "reason": "FailedMount", "message": "stale", "count": int32(1), "last_timestamp": iso(issuesNow.Add(-3 * time.Hour)), "involved_object": m{"kind": "Pod", "namespace": "a", "name": "stale"}},
		{"type": "Normal", "reason": "Pulled", "message": "ok", "count": int32(1), "last_timestamp": iso(issuesNow), "involved_object": m{"kind": "Pod", "namespace": "a", "name": "normal"}},
		{"type": "Warning", "reason": "NoName", "message": "x", "last_timestamp": iso(issuesNow), "involved_object": m{"kind": "Pod"}},
	}
	got := mergeEvents(issues, toMaps(events), issuesNow, time.Hour)
	if len(got) != 4 {
		t.Fatalf("got %d: %+v", len(got), got)
	}
	web := findIssue(t, got, "Pod/a/web")
	if web.Message != "Unhealthy: Readiness probe failed: 503" || web.Count != 12 || web.LastSeen != iso(issuesNow.Add(-5*time.Minute)) || web.Reason != "Ready 0/1" {
		t.Errorf("web: %+v", web)
	}
	orphan := findIssue(t, got, "Pod/a/orphan")
	if orphan.Severity != severityWarning || orphan.Reason != "FailedScheduling" || orphan.Message != "0/3 nodes are available" {
		t.Errorf("orphan: %+v", orphan)
	}
	order := []string{got[0].ID, got[1].ID, got[2].ID, got[3].ID}
	want := []string{"Node/n1", "Pod/a/orphan", "Pod/a/web", "HorizontalPodAutoscaler/a/h"}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
	if empty := mergeEvents(nil, nil, issuesNow, time.Hour); empty == nil || len(empty) != 0 {
		t.Errorf("nil issues should become an empty slice, got %#v", empty)
	}
}

func toMaps(in []m) []map[string]interface{} {
	out := make([]map[string]interface{}, len(in))
	for i, it := range in {
		out[i] = map[string]interface{}(it)
	}
	return out
}
