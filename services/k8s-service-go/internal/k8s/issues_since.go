package k8s

import (
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/eventtime"
)

// From when an issue's object has been failing (IssuesOptions.Since), out of the lists the check reads anyway: a pod's
// own status, the back-off events of one that restarts, the pods of a workload, an event that keeps coming. A time is
// given only when the record shows the failure without a gap from it, so a failure that came back after its object had
// been well is not dated by the run before: such an issue has no Since, which is not known and not new.

const (
	backOffReason = "BackOff"
	// The kubelet counts a back-off event about once a minute while its container keeps failing (0.9 to 1.3 a minute in
	// recorded runs, the count going on past the 25 writes it is limited to), so half of that over the whole time is asked
	// for. The limit writes one every 5 minutes then, so an event not written for eventQuiet no longer comes.
	eventEvery = 2 * time.Minute
	eventQuiet = 15 * time.Minute
)

// podSince is what a pod's object says of its issue's Since.
type podSince struct {
	uid   types.UID
	owner string    // the ID of the issue its workload would have, "" without one
	at    time.Time // from when; zero when the object does not say
	loops bool      // a container of it restarted: its back-off events say from when
}

// withPodSince gives each issue of found what its pod among pods says.
func withPodSince(found []Issue, pods []corev1.Pod) {
	if len(found) == 0 {
		return
	}
	byID := make(map[string]*corev1.Pod, len(pods))
	for i := range pods {
		byID[issueID("Pod", pods[i].Namespace, pods[i].Name)] = &pods[i]
	}
	for i := range found {
		if p, ok := byID[found[i].ID]; ok {
			found[i].pod = podSinceOf(p)
		}
	}
}

// podSinceOf: a pod that is Pending has been since it was made, a Failed one since its last container ended, and one that
// is not ready since its Ready condition says, unless a container that comes and goes takes the condition with it.
func podSinceOf(p *corev1.Pod) podSince {
	out := podSince{uid: p.UID, owner: workloadIssueID(p)}
	statuses := append(append([]corev1.ContainerStatus{}, p.Status.InitContainerStatuses...), p.Status.ContainerStatuses...)
	switch p.Status.Phase {
	case corev1.PodPending:
		out.at = p.CreationTimestamp.Time
		return out
	case corev1.PodFailed:
		for _, cs := range statuses {
			if t := cs.State.Terminated; t != nil && t.FinishedAt.After(out.at) {
				out.at = t.FinishedAt.Time
			}
		}
		return out
	}
	for _, c := range p.Status.Conditions {
		if c.Type != corev1.PodReady || c.Status == corev1.ConditionTrue {
			continue
		}
		for _, cs := range statuses {
			if !cs.Ready && !downSince(cs, c.LastTransitionTime.Time) {
				out.loops = true
				return out
			}
		}
		out.at = c.LastTransitionTime.Time
		return out
	}
	for _, cs := range statuses {
		out.loops = out.loops || cs.RestartCount > 0
	}
	return out
}

// downSince reports whether a container that is not ready has been so since t, when its pod stopped being ready: it never
// restarted, it was not ready all through its run before this one, or it was ready earlier in the run it is in.
func downSince(cs corev1.ContainerStatus, t time.Time) bool {
	if cs.RestartCount == 0 {
		return true
	}
	if last := cs.LastTerminationState.Terminated; last != nil && !last.StartedAt.IsZero() && !t.After(last.StartedAt.Time) {
		return true
	}
	return cs.State.Running != nil && t.After(cs.State.Running.StartedAt.Time)
}

// workloadIssueID is the ID of the issue of the workload that made a pod: its controller's, a ReplicaSet's Deployment's
// (its name without the pod template hash the pod's label holds).
func workloadIssueID(p *corev1.Pod) string {
	owner := metav1.GetControllerOf(p)
	if owner == nil {
		return ""
	}
	if hash := p.Labels["pod-template-hash"]; owner.Kind == "ReplicaSet" && hash != "" {
		if name, ok := strings.CutSuffix(owner.Name, "-"+hash); ok {
			return issueID("Deployment", p.Namespace, name)
		}
	}
	return issueID(owner.Kind, p.Namespace, owner.Name)
}

// eventRun is when one event was first and last written, and how many times.
type eventRun struct {
	first, last time.Time
	count       int
}

// since is from when the event has kept coming: its first time, zero when it came too seldom since then to be one run of
// failures, or no longer comes.
func (r eventRun) since(now time.Time) time.Time {
	if r.count < 2 || now.Sub(r.last) > eventQuiet || time.Duration(r.count)*eventEvery < r.last.Sub(r.first) {
		return time.Time{}
	}
	return r.first
}

// backOffs keeps the back-off events of each pod as the events are read: one a container that waits to be started again.
type backOffs struct {
	mu  sync.Mutex // the namespaces of a limited grant are read side by side
	pod map[types.UID][]eventRun
}

func (b *backOffs) add(e *corev1.Event) {
	if e.Reason != backOffReason || e.InvolvedObject.Kind != "Pod" || e.InvolvedObject.UID == "" {
		return
	}
	first, _, count := eventtime.Seen(e)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pod == nil {
		b.pod = map[types.UID][]eventRun{}
	}
	b.pod[e.InvolvedObject.UID] = append(b.pod[e.InvolvedObject.UID], eventRun{first: first, last: eventtime.Last(e), count: int(count)})
}

// since is from when a pod's containers have been failing: the latest of those that still are, zero when one of them does
// not say, so that a container that began to fail beside an older one is not dated by it.
func (b *backOffs) since(uid types.UID, now time.Time) time.Time {
	var at time.Time
	for _, r := range b.pod[uid] {
		if now.Sub(r.last) > eventQuiet {
			continue
		}
		s := r.since(now)
		if s.IsZero() {
			return time.Time{}
		}
		if s.After(at) {
			at = s
		}
	}
	return at
}

// issueIDs are the IDs of the check's own issues, before mergeEvents adds the rows events make.
func issueIDs(issues []Issue) map[string]bool {
	ids := make(map[string]bool, len(issues))
	for _, is := range issues {
		ids[is.ID] = true
	}
	return ids
}

// fillSince sets Since on the merged issues: a pod's, the rows events made (not in own) and then a workload's, the latest
// of its pods that are down, none when one of them is not known: the number of its pods that are down last grew then.
func fillSince(issues []Issue, own map[string]bool, events []map[string]interface{}, loops *backOffs, now time.Time) {
	runs := map[string]eventRun{}
	for _, e := range events {
		obj := mapMap(e, "involved_object")
		id := issueID(eventObjectKind(mapStr(obj, "kind"), mapStr(obj, "api_version")), mapStr(obj, "namespace"), mapStr(obj, "name"))
		first, err := time.Parse(time.RFC3339, mapStr(e, "first_timestamp"))
		last, lastErr := time.Parse(time.RFC3339, mapStr(e, "last_timestamp"))
		if err == nil && lastErr == nil {
			runs[id] = eventRun{first: first, last: last, count: mapInt(e, "count")}
		}
	}
	latest, unknown := map[string]time.Time{}, map[string]bool{}
	for i := range issues {
		is := &issues[i]
		var at time.Time
		switch {
		case !own[is.ID]:
			if r, ok := runs[is.ID]; ok {
				at = r.since(now)
			}
		case is.Kind == "Pod":
			at = is.pod.at
			if is.pod.loops {
				at = loops.since(is.pod.uid, now)
			}
			if is.pod.owner != "" && !strings.HasPrefix(is.Reason, restartedReason) {
				if at.IsZero() {
					unknown[is.pod.owner] = true
				} else if at.After(latest[is.pod.owner]) {
					latest[is.pod.owner] = at
				}
			}
		}
		is.Since = eventtime.ISO(at)
	}
	for i := range issues {
		if is := &issues[i]; own[is.ID] && is.Kind != "Pod" && !unknown[is.ID] {
			is.Since = eventtime.ISO(latest[is.ID])
		}
	}
}
