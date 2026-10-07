package k8s

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Issue is one thing wrong in the cluster, for the dashboard's "Check issues"
// action: the object, how bad it is, the reason, the last message the cluster
// gave about it, when that was and how often.
type Issue struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
	Severity  string `json:"severity"` // critical | warning | info
	Reason    string `json:"reason,omitempty"`
	Message   string `json:"message,omitempty"`
	LastSeen  string `json:"last_seen,omitempty"`
	Count     int    `json:"count,omitempty"`
}

const (
	severityCritical = "critical"
	severityWarning  = "warning"
	severityInfo     = "info"
)

// IssuesOptions: Window is how far back Warning events are read;
// IncludeRestartHistory also lists healthy pods whose last restart is older
// than a day (as info).
type IssuesOptions struct {
	Window                time.Duration
	IncludeRestartHistory bool
	Now                   time.Time
}

// CollectIssues gathers the issues of the ctx cluster. Pods and nodes are
// required; a list that fails elsewhere becomes an info issue of kind
// Collector so the gap is visible instead of silent.
func (s *Service) CollectIssues(ctx context.Context, opts IssuesOptions) ([]Issue, error) {
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	pods, err := s.GetAllPods(ctx)
	if err != nil {
		return nil, err
	}
	nodes, err := s.GetNodes(ctx)
	if err != nil {
		return nil, err
	}
	var issues []Issue
	collect := func(what string, fn func(context.Context) ([]map[string]interface{}, error)) []map[string]interface{} {
		items, err := fn(ctx)
		if err != nil {
			issues = append(issues, Issue{ID: "Collector/" + what, Kind: "Collector", Name: what, Severity: severityInfo, Reason: "ListFailed", Message: err.Error()})
		}
		return items
	}
	deployments := collect("deployments", s.GetAllDeployments)
	statefulsets := collect("statefulsets", s.GetAllStatefulSets)
	daemonsets := collect("daemonsets", s.GetAllDaemonSets)
	jobs := collect("jobs", s.GetAllJobs)
	cronjobs := collect("cronjobs", s.GetAllCronJobs)
	hpas := collect("hpas", s.GetAllHPAs)
	pvcs := collect("pvcs", s.GetAllPVCs)
	events := collect("events", func(ctx context.Context) ([]map[string]interface{}, error) { return s.GetEvents(ctx, "", "") })

	issues = append(issues, issuesFromNodes(nodes)...)
	issues = append(issues, issuesFromPods(pods, opts)...)
	issues = append(issues, issuesFromWorkloads(deployments, statefulsets, daemonsets)...)
	issues = append(issues, issuesFromJobs(jobs, cronjobs)...)
	issues = append(issues, issuesFromHPAs(hpas)...)
	issues = append(issues, issuesFromPVCs(pvcs)...)
	return mergeEvents(issues, events, opts.Now, opts.Window), nil
}

func mapInt(m map[string]interface{}, key string) int {
	if m == nil {
		return 0
	}
	switch v := m[key].(type) {
	case int:
		return v
	case int32:
		return int(v)
	case int64:
		return int(v)
	case float64:
		return int(v)
	}
	return 0
}

func mapList(m map[string]interface{}, key string) []map[string]interface{} {
	if m == nil {
		return nil
	}
	switch v := m[key].(type) {
	case []map[string]interface{}:
		return v
	case []interface{}:
		out := make([]map[string]interface{}, 0, len(v))
		for _, it := range v {
			if mm, ok := it.(map[string]interface{}); ok {
				out = append(out, mm)
			}
		}
		return out
	}
	return nil
}

func issueID(kind, ns, name string) string {
	if ns == "" {
		return kind + "/" + name
	}
	return kind + "/" + ns + "/" + name
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// issuesFromNodes: Ready not True, or a pressure condition True.
func issuesFromNodes(nodes []map[string]interface{}) []Issue {
	var out []Issue
	for _, n := range nodes {
		name := mapStr(n, "name")
		for _, c := range mapList(n, "conditions") {
			typ, st := mapStr(c, "type"), mapStr(c, "status")
			msg := strings.TrimSpace(mapStr(c, "reason") + " " + mapStr(c, "message"))
			switch {
			case typ == "Ready" && st != "True":
				out = append(out, Issue{ID: issueID("Node", "", name), Kind: "Node", Name: name, Severity: severityCritical, Reason: "NotReady", Message: msg})
			case (typ == "MemoryPressure" || typ == "DiskPressure" || typ == "PIDPressure" || typ == "NetworkUnavailable") && st == "True":
				out = append(out, Issue{ID: issueID("Node", "", name) + "/" + typ, Kind: "Node", Name: name, Severity: severityWarning, Reason: typ, Message: msg})
			}
		}
	}
	return out
}

var criticalWaitingReasons = map[string]bool{
	"CrashLoopBackOff": true, "ImagePullBackOff": true, "ErrImagePull": true, "InvalidImageName": true,
	"CreateContainerConfigError": true, "CreateContainerError": true, "RunContainerError": true,
}

// issuesFromPods: a phase other than Running/Succeeded, a Running pod that is
// not ready, a container waiting for a known-bad reason or terminated, and
// restarts (within a day, or any with IncludeRestartHistory). A Failed pod of
// a Job is a warning (the Job row carries the failure).
func issuesFromPods(pods []map[string]interface{}, opts IssuesOptions) []Issue {
	var out []Issue
	for _, p := range pods {
		ns, name, phase := mapStr(p, "namespace"), mapStr(p, "name"), mapStr(p, "phase")
		if phase == "Succeeded" {
			continue
		}
		var reasons []string
		critical := false
		var lastRestart time.Time
		lastRestartReason := ""
		for _, c := range append(mapList(p, "containers"), mapList(p, "init_containers")...) {
			state := mapMap(c, "state")
			if w := mapMap(state, "waiting"); w != nil {
				if r := mapStr(w, "reason"); r != "" {
					reasons = append(reasons, r)
					if criticalWaitingReasons[r] {
						critical = true
					}
				}
			}
			if t := mapMap(state, "terminated"); t != nil {
				if r := mapStr(t, "reason"); r != "" && r != "Completed" {
					reasons = append(reasons, r)
					critical = true
				}
			}
			if lt := mapMap(mapMap(c, "last_state"), "terminated"); lt != nil {
				if fin, err := time.Parse(time.RFC3339, mapStr(lt, "finished_at")); err == nil && fin.After(lastRestart) {
					lastRestart, lastRestartReason = fin, mapStr(lt, "reason")
				}
			}
		}
		runningNotReady := false
		if phase == "Running" {
			if parts := strings.SplitN(mapStr(p, "ready"), "/", 2); len(parts) == 2 && parts[0] != parts[1] {
				runningNotReady = true
			}
		}
		jobPod := false
		for _, o := range mapList(p, "owner_references") {
			if mapStr(o, "kind") == "Job" {
				jobPod = true
			}
		}
		severity := ""
		switch {
		case phase == "Failed" && jobPod:
			severity = severityWarning
		case critical || phase == "Failed" || phase == "Unknown":
			severity = severityCritical
		case phase == "Pending" || runningNotReady:
			severity = severityWarning
		}
		restarts := mapInt(p, "restart_count")
		if severity != "" {
			if phase != "Running" {
				reasons = append([]string{"Phase " + phase}, reasons...)
			} else if runningNotReady {
				reasons = append(reasons, "Ready "+mapStr(p, "ready"))
			}
			out = append(out, Issue{ID: issueID("Pod", ns, name), Kind: "Pod", Namespace: ns, Name: name, Severity: severity,
				Reason: strings.Join(uniqueStrings(reasons), ", "), Message: mapStr(p, "message"), Count: restarts})
			continue
		}
		if restarts == 0 || lastRestart.IsZero() {
			continue
		}
		age := opts.Now.Sub(lastRestart)
		switch {
		case age <= time.Hour:
			severity = severityWarning
		case age <= 24*time.Hour || opts.IncludeRestartHistory:
			severity = severityInfo
		default:
			continue
		}
		out = append(out, Issue{ID: issueID("Pod", ns, name), Kind: "Pod", Namespace: ns, Name: name, Severity: severity,
			Reason: "Restarted: " + lastRestartReason, LastSeen: lastRestart.UTC().Format(time.RFC3339), Count: restarts})
	}
	return out
}

// issuesFromWorkloads: replicas that are not available, and a Deployment
// whose rollout failed (Progressing=False, e.g. ProgressDeadlineExceeded).
func issuesFromWorkloads(deployments, statefulsets, daemonsets []map[string]interface{}) []Issue {
	var out []Issue
	for _, d := range deployments {
		ns, name := mapStr(d, "namespace"), mapStr(d, "name")
		want, avail := mapInt(d, "replicas"), mapInt(d, "available_replicas")
		msg := fmt.Sprintf("available %d/%d", avail, want)
		if reason := mapStr(d, "progressing_reason"); reason != "" {
			out = append(out, Issue{ID: issueID("Deployment", ns, name), Kind: "Deployment", Namespace: ns, Name: name, Severity: severityCritical, Reason: reason, Message: msg})
			continue
		}
		if want > 0 && avail < want {
			sev := severityWarning
			if avail == 0 {
				sev = severityCritical
			}
			out = append(out, Issue{ID: issueID("Deployment", ns, name), Kind: "Deployment", Namespace: ns, Name: name, Severity: sev, Reason: "Unavailable", Message: msg})
		}
	}
	for _, st := range statefulsets {
		ns, name := mapStr(st, "namespace"), mapStr(st, "name")
		want, ready := mapInt(st, "replicas"), mapInt(st, "ready_replicas")
		if want > 0 && ready < want {
			sev := severityWarning
			if ready == 0 {
				sev = severityCritical
			}
			out = append(out, Issue{ID: issueID("StatefulSet", ns, name), Kind: "StatefulSet", Namespace: ns, Name: name, Severity: sev, Reason: "NotReady", Message: fmt.Sprintf("ready %d/%d", ready, want)})
		}
	}
	for _, d := range daemonsets {
		ns, name := mapStr(d, "namespace"), mapStr(d, "name")
		if un := mapInt(d, "unavailable"); un > 0 {
			out = append(out, Issue{ID: issueID("DaemonSet", ns, name), Kind: "DaemonSet", Namespace: ns, Name: name, Severity: severityWarning, Reason: "Unavailable", Message: fmt.Sprintf("ready %d/%d", mapInt(d, "ready"), mapInt(d, "desired"))})
		}
	}
	return out
}

// issuesFromJobs: a failed Job (or one still retrying), and a CronJob whose
// last scheduled run has not succeeded.
func issuesFromJobs(jobs, cronjobs []map[string]interface{}) []Issue {
	var out []Issue
	for _, j := range jobs {
		ns, name := mapStr(j, "namespace"), mapStr(j, "name")
		failed := mapInt(j, "failed")
		switch {
		case mapStr(j, "status") == "Failed":
			out = append(out, Issue{ID: issueID("Job", ns, name), Kind: "Job", Namespace: ns, Name: name, Severity: severityWarning, Reason: "Failed", Message: fmt.Sprintf("failed %d, succeeded %d", failed, mapInt(j, "succeeded")), Count: failed})
		case failed > 0 && mapInt(j, "active") > 0:
			out = append(out, Issue{ID: issueID("Job", ns, name), Kind: "Job", Namespace: ns, Name: name, Severity: severityInfo, Reason: "Retrying", Message: fmt.Sprintf("failed %d, active %d", failed, mapInt(j, "active")), Count: failed})
		}
	}
	for _, c := range cronjobs {
		ns, name := mapStr(c, "namespace"), mapStr(c, "name")
		sched, ok := mapStr(c, "last_schedule"), mapStr(c, "last_successful")
		if sched != "" && ok < sched && mapInt(c, "active") == 0 {
			if ok == "" {
				ok = "never"
			}
			out = append(out, Issue{ID: issueID("CronJob", ns, name), Kind: "CronJob", Namespace: ns, Name: name, Severity: severityWarning, Reason: "LastRunNotSucceeded", Message: "last schedule " + sched + ", last success " + ok, LastSeen: sched})
		}
	}
	return out
}

// issuesFromHPAs: the autoscaler is at its ceiling.
func issuesFromHPAs(hpas []map[string]interface{}) []Issue {
	var out []Issue
	for _, h := range hpas {
		ns, name := mapStr(h, "namespace"), mapStr(h, "name")
		max, cur := mapInt(h, "max_replicas"), mapInt(h, "current_replicas")
		if max > 0 && cur >= max {
			out = append(out, Issue{ID: issueID("HorizontalPodAutoscaler", ns, name), Kind: "HorizontalPodAutoscaler", Namespace: ns, Name: name, Severity: severityInfo, Reason: "AtMaxReplicas", Message: fmt.Sprintf("current %d, max %d", cur, max)})
		}
	}
	return out
}

// issuesFromPVCs: a claim that is not bound.
func issuesFromPVCs(pvcs []map[string]interface{}) []Issue {
	var out []Issue
	for _, p := range pvcs {
		ns, name, st := mapStr(p, "namespace"), mapStr(p, "name"), mapStr(p, "status")
		if st == "" || st == "Bound" {
			continue
		}
		sev := severityWarning
		if st == "Lost" {
			sev = severityCritical
		}
		out = append(out, Issue{ID: issueID("PersistentVolumeClaim", ns, name), Kind: "PersistentVolumeClaim", Namespace: ns, Name: name, Severity: sev, Reason: st})
	}
	return out
}

// mergeEvents attaches the newest Warning event inside the window to the
// issue about the same object and lists the rest as warnings of their own,
// then sorts critical → warning → info, kind, id.
func mergeEvents(issues []Issue, events []map[string]interface{}, now time.Time, window time.Duration) []Issue {
	byID := map[string]int{}
	for i, is := range issues {
		byID[is.ID] = i
	}
	extra := map[string]Issue{}
	for _, e := range events {
		if mapStr(e, "type") != "Warning" {
			continue
		}
		last, err := time.Parse(time.RFC3339, mapStr(e, "last_timestamp"))
		if err != nil || now.Sub(last) > window {
			continue
		}
		obj := mapMap(e, "involved_object")
		kind, ns, name := mapStr(obj, "kind"), mapStr(obj, "namespace"), mapStr(obj, "name")
		if kind == "" || name == "" {
			continue
		}
		id := issueID(kind, ns, name)
		reason, msg, count, ts := mapStr(e, "reason"), mapStr(e, "message"), mapInt(e, "count"), last.UTC().Format(time.RFC3339)
		if i, ok := byID[id]; ok {
			is := &issues[i]
			if is.LastSeen == "" || ts > is.LastSeen {
				is.LastSeen, is.Message = ts, reason+": "+msg
				if count > is.Count {
					is.Count = count
				}
			}
			continue
		}
		if prev, ok := extra[id]; !ok || ts > prev.LastSeen {
			extra[id] = Issue{ID: id, Kind: kind, Namespace: ns, Name: name, Severity: severityWarning, Reason: reason, Message: msg, LastSeen: ts, Count: count}
		}
	}
	for _, is := range extra {
		issues = append(issues, is)
	}
	rank := map[string]int{severityCritical: 0, severityWarning: 1, severityInfo: 2}
	sort.SliceStable(issues, func(i, j int) bool {
		if rank[issues[i].Severity] != rank[issues[j].Severity] {
			return rank[issues[i].Severity] < rank[issues[j].Severity]
		}
		if issues[i].Kind != issues[j].Kind {
			return issues[i].Kind < issues[j].Kind
		}
		return issues[i].ID < issues[j].ID
	})
	if issues == nil {
		issues = []Issue{}
	}
	return issues
}
