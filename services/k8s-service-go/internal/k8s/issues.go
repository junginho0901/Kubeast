package k8s

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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
	// APIVersion is the event's object's, on a row an event made, so a Kind two groups serve opens the right object.
	APIVersion string `json:"api_version,omitempty"`
	// Each number counts one thing: a pod's restarts (kubectl's RESTARTS), a Job's failed pods, and how many times the
	// issue's newest Warning event happened (kubectl get events' COUNT).
	Restarts int `json:"restarts,omitempty"`
	Failed   int `json:"failed,omitempty"`
	Events   int `json:"events,omitempty"`
	// Namespaces are those of a limited grant a list was refused in, on the row (Kind Collector) that says so.
	Namespaces []string `json:"namespaces,omitempty"`
	// Since, with IssuesOptions.Since only: the time from which the record shows the object failing without a gap
	// (issues_since.go). It may have begun earlier; "" is not known, which is not new.
	Since string `json:"since,omitempty"`

	pod podSince
}

const (
	severityCritical = "critical"
	severityWarning  = "warning"
	severityInfo     = "info"
)

// IssuesOptions: Window is how far back Warning events are read;
// IncludeRestartHistory also lists healthy pods whose last restart is older
// than a day (as info); Namespace reads that namespace's objects only (the
// nodes stay whole); Since fills each issue's Since from the same lists.
type IssuesOptions struct {
	Window                time.Duration
	IncludeRestartHistory bool
	Now                   time.Time
	Namespace             string
	Since                 bool
}

// CollectIssues gathers the issues of the ctx cluster. Pods are required; a
// list that fails elsewhere — nodes too, which a grant limited to namespaces
// may not list — becomes an info issue of kind Collector so the gap is
// visible instead of silent. So does a list, the pods too, that a namespace of
// such a grant refused, naming those namespaces.
func (s *Service) CollectIssues(ctx context.Context, opts IssuesOptions) ([]Issue, error) {
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	var issues []Issue
	unread := func(what, why string, namespaces []string) {
		issues = append(issues, Issue{ID: "Collector/" + what, Kind: "Collector", Name: what, Severity: severityInfo, Reason: "ListFailed", Message: why, Namespaces: namespaces})
	}
	partly := func(what string, notes *refusedNamespaces) {
		if names, why := notes.refused(); len(names) > 0 {
			unread(what, notReadIn(names, why.Error()), names)
		}
	}
	podsCtx, podsRefused := noteRefusedNamespaces(ctx)
	podIssues, err := s.podIssues(podsCtx, opts)
	if err != nil {
		return nil, err
	}
	partly("pods", podsRefused)
	collect := func(what string, fn func(context.Context) ([]map[string]interface{}, error)) []map[string]interface{} {
		listCtx, refused := noteRefusedNamespaces(ctx)
		items, err := fn(listCtx)
		if err != nil {
			unread(what, err.Error(), nil)
		} else {
			partly(what, refused)
		}
		return items
	}
	// in one namespace when the options name it, else across the namespaces the caller reads
	each := func(all func(context.Context) ([]map[string]interface{}, error), one func(context.Context, string) ([]map[string]interface{}, error)) func(context.Context) ([]map[string]interface{}, error) {
		if opts.Namespace == "" {
			return all
		}
		return func(ctx context.Context) ([]map[string]interface{}, error) { return one(ctx, opts.Namespace) }
	}
	nodes := collect("nodes", s.GetNodes)
	deployments := collect("deployments", each(s.GetAllDeployments, s.GetDeployments))
	statefulsets := collect("statefulsets", each(s.GetAllStatefulSets, s.GetStatefulSets))
	daemonsets := collect("daemonsets", each(s.GetAllDaemonSets, s.GetDaemonSets))
	jobs := collect("jobs", each(s.GetAllJobs, s.GetJobs))
	cronjobs := collect("cronjobs", each(s.GetAllCronJobs, s.GetCronJobs))
	hpas := collect("hpas", each(s.GetAllHPAs, s.GetHPAs))
	pvcs := collect("pvcs", each(s.GetAllPVCs, s.GetPVCs))
	var loops backOffs
	var also []func(*corev1.Event)
	if opts.Since {
		also = append(also, loops.add)
	}
	events := collect("events", func(ctx context.Context) ([]map[string]interface{}, error) {
		if opts.Namespace != "" {
			return s.warningEventRowsIn(ctx, opts.Namespace, opts.Now.Add(-opts.Window), also...)
		}
		return s.warningEventRows(ctx, opts.Now.Add(-opts.Window), also...)
	})

	issues = append(issues, issuesFromNodes(nodes)...)
	issues = append(issues, podIssues...)
	issues = append(issues, issuesFromWorkloads(deployments, statefulsets, daemonsets)...)
	issues = append(issues, issuesFromJobs(jobs, cronjobs)...)
	issues = append(issues, issuesFromHPAs(hpas)...)
	issues = append(issues, issuesFromPVCs(pvcs)...)
	var own map[string]bool
	if opts.Since {
		own = issueIDs(issues)
	}
	issues = mergeEvents(issues, events, opts.Now, opts.Window)
	if opts.Since {
		fillSince(issues, own, events, &loops, opts.Now)
	}
	return issues, nil
}

// podIssues reads the pods podListChunk at a time — in each namespace of a namespace-limited user's scope, as
// listAcrossNamespaces — and keeps each page's issues only: 50 000 pods as one list took k8s-service past 512 Mi.
func (s *Service) podIssues(ctx context.Context, opts IssuesOptions) ([]Issue, error) {
	list := func(namespace string) ([]Issue, error) {
		var out []Issue
		err := eachPage(ctx, metav1.ListOptions{Limit: podListChunk}, func(lo metav1.ListOptions) (*corev1.PodList, error) {
			return s.clientsetCtx(ctx).CoreV1().Pods(namespace).List(ctx, lo)
		}, func(l *corev1.PodList) {
			found := issuesFromPods(formatPodList(l.Items), opts)
			if opts.Since {
				withPodSince(found, l.Items)
			}
			out = append(out, found...)
		})
		if err != nil {
			return nil, err
		}
		return out, nil
	}
	if opts.Namespace != "" {
		return list(opts.Namespace)
	}
	if scope := scopeFromCtx(ctx); len(scope) > 0 {
		return fanOutNamespaces(scope, list, noteRefusedTo(ctx))
	}
	return list("")
}

// warningEventRows: the Warning events since since (the API server selects type=Warning), read a page at a time —
// in each namespace of a namespace-limited user's scope, as listAcrossNamespaces — the newest of each object kept (by
// eventObjectKind, as mergeEvents keys them): what mergeEvents takes from them. also is given every one of them.
func (s *Service) warningEventRows(ctx context.Context, since time.Time, also ...func(*corev1.Event)) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(namespace string) ([]map[string]interface{}, error) {
		return s.warningEventRowsIn(ctx, namespace, since, also...)
	})
}

func (s *Service) warningEventRowsIn(ctx context.Context, namespace string, since time.Time, also ...func(*corev1.Event)) ([]map[string]interface{}, error) {
	newest := map[string]*corev1.Event{}
	var order []string
	err := s.eachEvent(ctx, namespace, metav1.ListOptions{FieldSelector: "type=" + corev1.EventTypeWarning}, func(e *corev1.Event) {
		if eventTimestamp(*e).Before(since) {
			return
		}
		for _, f := range also {
			f(e)
		}
		id := issueID(eventObjectKind(e.InvolvedObject.Kind, e.InvolvedObject.APIVersion), e.InvolvedObject.Namespace, e.InvolvedObject.Name)
		if prev, ok := newest[id]; ok && !eventTimestamp(*e).After(eventTimestamp(*prev)) {
			return
		} else if !ok {
			order = append(order, id)
		}
		c := *e
		newest[id] = &c
	})
	if err != nil {
		return nil, err
	}
	rows := make([]map[string]interface{}, 0, len(order))
	for _, id := range order {
		rows = append(rows, eventRow(newest[id]))
	}
	return rows, nil
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

// restartedReason starts the reason of a pod that restarted and runs again.
const restartedReason = "Restarted: "

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
				Reason: strings.Join(uniqueStrings(reasons), ", "), Message: mapStr(p, "message"), Restarts: restarts})
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
			Reason: restartedReason + lastRestartReason, LastSeen: lastRestart.UTC().Format(time.RFC3339), Restarts: restarts})
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
// last scheduled run has not succeeded. FailureTarget has failed too: the
// controller is only waiting for its last pods to leave. Only a Running Job
// retries: the pods left on a suspended, deleted or finishing one are leaving.
// Between two tries it has no active pod and has not given up, so it stays.
func issuesFromJobs(jobs, cronjobs []map[string]interface{}) []Issue {
	var out []Issue
	for _, j := range jobs {
		ns, name := mapStr(j, "namespace"), mapStr(j, "name")
		failed := mapInt(j, "failed")
		switch status := mapStr(j, "status"); {
		case status == "Failed" || status == "FailureTarget":
			out = append(out, Issue{ID: issueID("Job", ns, name), Kind: "Job", Namespace: ns, Name: name, Severity: severityWarning, Reason: status, Message: fmt.Sprintf("failed %d, succeeded %d", failed, mapInt(j, "succeeded")), Failed: failed})
		case status == "Running" && failed > 0:
			out = append(out, Issue{ID: issueID("Job", ns, name), Kind: "Job", Namespace: ns, Name: name, Severity: severityInfo, Reason: "Retrying", Message: fmt.Sprintf("failed %d, active %d", failed, mapInt(j, "active")), Failed: failed})
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

// issueKindGroups are the API groups of the kinds the check reads itself: an event about a kind of the same name in
// another group is about another object.
var issueKindGroups = map[string]string{
	"Pod": "", "Node": "", "PersistentVolumeClaim": "", "Deployment": "apps", "StatefulSet": "apps", "DaemonSet": "apps",
	"Job": "batch", "CronJob": "batch", "HorizontalPodAutoscaler": "autoscaling",
}

// apiGroup is an apiVersion's group ("" for the core v1).
func apiGroup(apiVersion string) string {
	if i := strings.Index(apiVersion, "/"); i > 0 {
		return apiVersion[:i]
	}
	return ""
}

// eventObjectKind is the kind an event's object is keyed by: the kind, with its group when that is not the group of
// the check's own kind of that name.
func eventObjectKind(kind, apiVersion string) string {
	group := apiGroup(apiVersion)
	if g, ok := issueKindGroups[kind]; group == "" || (ok && g == group) {
		return kind
	}
	return kind + "." + group
}

// mergeEvents attaches the newest Warning event inside the window to the most
// severe issue about the same object (a node's pressure rows too) and lists the
// rest as warnings of their own, then sorts critical → warning → info, kind, id.
func mergeEvents(issues []Issue, events []map[string]interface{}, now time.Time, window time.Duration) []Issue {
	rank := map[string]int{severityCritical: 0, severityWarning: 1, severityInfo: 2}
	byObj := map[string]int{}
	for i, is := range issues {
		key := issueID(is.Kind, is.Namespace, is.Name)
		if j, ok := byObj[key]; !ok || rank[is.Severity] < rank[issues[j].Severity] {
			byObj[key] = i
		}
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
		id := issueID(eventObjectKind(kind, mapStr(obj, "api_version")), ns, name)
		reason, msg, count, ts := mapStr(e, "reason"), mapStr(e, "message"), mapInt(e, "count"), last.UTC().Format(time.RFC3339)
		if i, ok := byObj[id]; ok {
			is := &issues[i]
			if is.LastSeen == "" || ts > is.LastSeen {
				is.LastSeen, is.Message, is.Events = ts, reason+": "+msg, count
			}
			continue
		}
		if prev, ok := extra[id]; !ok || ts > prev.LastSeen {
			extra[id] = Issue{ID: id, Kind: kind, APIVersion: mapStr(obj, "api_version"), Namespace: ns, Name: name, Severity: severityWarning, Reason: reason, Message: msg, LastSeen: ts, Events: count}
		}
	}
	for _, is := range extra {
		issues = append(issues, is)
	}
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
