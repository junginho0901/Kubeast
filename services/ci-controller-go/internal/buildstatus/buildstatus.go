// Package buildstatus reads what a build's Job and pod say (design ⓒ §6,
// §10): whether it waits, which step runs, how it ended and the digests the
// report container wrote. It only reads; the controller acts on it.
//
// The Job's conditions decide the end. Since Kubernetes 1.31 Complete and
// Failed come only after every pod has stopped, and SuccessCriteriaMet and
// FailureTarget come first, "to evaluate whether the Job has failed or
// succeeded without having to wait" (Job docs, "Termination of Job pods").
// The pod says the rest, as Tekton reads a TaskRun's pod (pkg/pod/status.go).
package buildstatus

import (
	"regexp"
	"strings"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"

	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/jobspec"
	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/queue"
)

// State of a build. The ones that end a build are the outcomes check runs
// map to conclusions (github.Outcome*).
type State string

const (
	Pending   State = "pending" // the Job exists, its pod does not run yet
	Running   State = "running"
	Succeeded State = "succeeded"
	Failed    State = "failed"
	TimedOut  State = "timed-out"
	Cancelled State = "cancelled"
)

// ReportContainer is the container that writes the digests.
const ReportContainer = "report"

// Status is what one read found.
type Status struct {
	State State
	// Done: the Job has ended or is ending; the state will not change.
	Done bool
	// Step is the step (container) running now, the one the pod waits on,
	// or the one that failed.
	Step string
	// Reason is Kubernetes' word for why the pod waits or the step failed:
	// Unschedulable, ImagePullBackOff, ErrImagePull, CreateContainerConfigError,
	// OOMKilled, Error, Evicted, DeadlineExceeded, …
	Reason   string
	ExitCode int32
	Message  string
	// Stuck: the pod waits for something that does not come by waiting
	// (a bad image name, a missing Secret or ConfigMap). Tekton fails a
	// TaskRun on these at once; the controller may cancel.
	Stuck bool
	// Digests are the images built, by build step.
	Digests map[string]string
	// ReadLog: the report container's message was cut (the kubelet keeps
	// 12 KiB per pod, split among its containers) or lacks a build step;
	// its log has the same lines, while the pod is there.
	ReadLog bool
}

// stuckReasons do not clear by waiting.
var stuckReasons = map[string]bool{
	"InvalidImageName":           true,
	"ErrImageNeverPull":          true,
	"CreateContainerConfigError": true,
	"CreateContainerError":       true,
}

// Read decides a build's status. pod is the Job's pod, nil while there is
// none; buildSteps are the pipeline's steps that build an image, whose
// digests a successful build must report.
func Read(job *batchv1.Job, pod *corev1.Pod, buildSteps []string) Status {
	if job.Annotations[jobspec.CancelAnnotation] != "" {
		st := Status{State: Cancelled, Done: true, Message: job.Annotations[jobspec.CancelAnnotation]}
		if pod != nil {
			st.Step = current(pod)
		}
		return st
	}
	if c := condition(job, batchv1.JobComplete, batchv1.JobSuccessCriteriaMet); c != nil {
		st := Status{State: Succeeded, Done: true}
		st.Digests, st.ReadLog = digests(pod, buildSteps)
		return st
	}
	if c := condition(job, batchv1.JobFailed, batchv1.JobFailureTarget); c != nil {
		st := Status{State: Failed, Done: true, Reason: c.Reason, Message: c.Message}
		if c.Reason == batchv1.JobReasonDeadlineExceeded {
			st.State = TimedOut
		}
		if pod != nil {
			failure(pod, &st)
			if st.State == TimedOut && st.Step == "" {
				st.Step = current(pod)
			}
		}
		return st
	}
	if pod == nil {
		return Status{State: Pending}
	}
	// The phase stays Pending while init containers run, which here is
	// checkout and every step: the build runs once any container started.
	st := Status{State: Running, Step: current(pod)}
	if !started(pod) {
		st.State = Pending
		for _, c := range pod.Status.Conditions {
			if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse {
				st.Reason, st.Message = c.Reason, c.Message
			}
		}
	}
	// A container waiting with a reason says more than the phase.
	for _, s := range ordered(pod) {
		if w := s.State.Waiting; w != nil && w.Reason != "" && w.Reason != "PodInitializing" && w.Reason != "ContainerCreating" {
			st.Step, st.Reason, st.Message = s.Name, w.Reason, w.Message
			st.Stuck = stuckReasons[w.Reason]
			break
		}
		if s.State.Terminated == nil || s.State.Terminated.ExitCode != 0 {
			break
		}
	}
	// The pod failed and the Job controller has not said so yet: failed,
	// not yet Done.
	if pod.Status.Phase == corev1.PodFailed {
		st.State = Failed
		failure(pod, &st)
	}
	return st
}

// condition is the first of the types that is True.
func condition(job *batchv1.Job, types ...batchv1.JobConditionType) *batchv1.JobCondition {
	for _, t := range types {
		for i, c := range job.Status.Conditions {
			if c.Type == t && c.Status == corev1.ConditionTrue {
				return &job.Status.Conditions[i]
			}
		}
	}
	return nil
}

// ordered is the pod's containers as they run: init containers (checkout,
// the steps), then the report container.
func ordered(pod *corev1.Pod) []corev1.ContainerStatus {
	byName := map[string]corev1.ContainerStatus{}
	for _, s := range pod.Status.InitContainerStatuses {
		byName[s.Name] = s
	}
	for _, s := range pod.Status.ContainerStatuses {
		byName[s.Name] = s
	}
	var out []corev1.ContainerStatus
	add := func(name string) {
		if s, ok := byName[name]; ok {
			out = append(out, s)
		} else {
			out = append(out, corev1.ContainerStatus{Name: name})
		}
	}
	for _, c := range pod.Spec.InitContainers {
		add(c.Name)
	}
	for _, c := range pod.Spec.Containers {
		add(c.Name)
	}
	return out
}

// started: a container runs or has run.
func started(pod *corev1.Pod) bool {
	for _, s := range ordered(pod) {
		if s.State.Running != nil || s.State.Terminated != nil {
			return true
		}
	}
	return false
}

// current is the first container that has not finished well.
func current(pod *corev1.Pod) string {
	for _, s := range ordered(pod) {
		if t := s.State.Terminated; t == nil || t.ExitCode != 0 {
			return s.Name
		}
	}
	return ""
}

// failure fills in the step that failed and why: an eviction first, then
// the first container that ended badly, as Tekton's getFailureInfo.
func failure(pod *corev1.Pod, st *Status) {
	if pod.Status.Reason == "Evicted" {
		st.Reason, st.Message = "Evicted", pod.Status.Message
		st.Step = current(pod)
		return
	}
	for _, s := range ordered(pod) {
		t := s.State.Terminated
		if t == nil || (t.ExitCode == 0 && t.Reason != "OOMKilled") {
			continue
		}
		st.Step, st.ExitCode = s.Name, t.ExitCode
		if t.Reason != "" {
			st.Reason = t.Reason
		}
		if t.Message != "" && s.Name != ReportContainer {
			st.Message = t.Message
		}
		return
	}
}

var digestLine = regexp.MustCompile(`^([a-z0-9]([-a-z0-9]*[a-z0-9])?)=(sha256:[0-9a-f]{64})$`)

// ParseDigests reads the report container's lines ("<build step>=<digest>",
// from its termination message or its log). complete is false when a line
// is cut or not of that form.
func ParseDigests(s string) (map[string]string, bool) {
	out := map[string]string{}
	complete := true
	lines := strings.Split(s, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	} else if n > 0 {
		complete = false // the last line has no line break: it may be cut
	}
	for _, l := range lines {
		m := digestLine.FindStringSubmatch(l)
		if m == nil {
			complete = false
			continue
		}
		out[m[1]] = m[3]
	}
	return out, complete
}

// digests reads the report container's termination message.
func digests(pod *corev1.Pod, buildSteps []string) (map[string]string, bool) {
	if len(buildSteps) == 0 {
		return nil, false
	}
	if pod == nil {
		return nil, true
	}
	var msg string
	for _, s := range pod.Status.ContainerStatuses {
		if s.Name == ReportContainer && s.State.Terminated != nil {
			msg = s.State.Terminated.Message
		}
	}
	got, complete := ParseDigests(msg)
	if msg == "" {
		complete = false
	}
	for _, b := range buildSteps {
		if got[b] == "" {
			complete = false
		}
	}
	return got, !complete
}

// RunningBuilds are the builds whose Jobs have not ended, for
// queue.Restore after a restart. Jobs without Kubeast's labels, cancelled
// ones and ended ones are left out. isDefault says whether a repository's
// ref is its default branch, which the Job does not record.
func RunningBuilds(jobs []batchv1.Job, isDefault func(repo, ref string) bool) []queue.Build {
	var out []queue.Build
	for i := range jobs {
		j := &jobs[i]
		id := j.Labels[jobspec.LabelBuild]
		repo, ref := j.Annotations[jobspec.AnnotationRepo], j.Annotations[jobspec.AnnotationRef]
		if id == "" || repo == "" || ref == "" || j.DeletionTimestamp != nil {
			continue
		}
		if st := Read(j, nil, nil); st.Done {
			continue
		}
		b := queue.Build{ID: id, Repo: repo, Ref: ref, SHA: j.Annotations[jobspec.AnnotationCommit], Enqueued: j.CreationTimestamp.Time}
		if isDefault != nil {
			b.DefaultBranch = isDefault(repo, ref)
		}
		out = append(out, b)
	}
	return out
}
