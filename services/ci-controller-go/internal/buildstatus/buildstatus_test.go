package buildstatus

import (
	"fmt"
	"math/rand/v2"
	"reflect"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/jobspec"
	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/pipeline"
	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/queue"
	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/runner"
)

const (
	digestA = "sha256:" + "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
	digestB = "sha256:" + "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
)

// build renders the Job jobspec makes for the default pipeline (build
// "image", then "scan") and a pod of its template, so the containers are
// the real ones in the real order: checkout, image, scan, then report.
func build(t testing.TB, id string) (*batchv1.Job, *corev1.Pod) {
	t.Helper()
	p := pipeline.Default("ghcr.io/example/web", "registry")
	if err := p.Normalize(); err != nil {
		t.Fatal(err)
	}
	res, err := jobspec.Render(jobspec.Input{
		Pipeline: p,
		Build: jobspec.Build{ID: id, Repo: "example/web", RepoURL: "https://github.com/example/web.git",
			CommitSHA: "0123456789abcdef0123456789abcdef01234567", Ref: "refs/heads/main", Event: "push"},
		Namespace: "ci-builds",
		Profile:   runner.DefaultProfile(),
		Images:    runner.DefaultImages(),
		Secrets:   map[string]string{"registry": "ci-" + id + "-registry"},
	})
	if err != nil {
		t.Fatal(err)
	}
	pod := &corev1.Pod{Spec: res.Job.Spec.Template.Spec, Status: corev1.PodStatus{Phase: corev1.PodPending}}
	return res.Job, pod
}

func names(pod *corev1.Pod) []string {
	var n []string
	for _, c := range pod.Spec.InitContainers {
		n = append(n, c.Name)
	}
	for _, c := range pod.Spec.Containers {
		n = append(n, c.Name)
	}
	return n
}

func done(code int32, reason string) corev1.ContainerState {
	return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: code, Reason: reason}}
}

func running() corev1.ContainerState {
	return corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
}

func waiting(reason, msg string) corev1.ContainerState {
	return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason, Message: msg}}
}

// set gives the named containers states, init or main as the spec has them.
func set(pod *corev1.Pod, phase corev1.PodPhase, states map[string]corev1.ContainerState) {
	pod.Status.Phase = phase
	pod.Status.InitContainerStatuses, pod.Status.ContainerStatuses = nil, nil
	for _, c := range pod.Spec.InitContainers {
		if s, ok := states[c.Name]; ok {
			pod.Status.InitContainerStatuses = append(pod.Status.InitContainerStatuses, corev1.ContainerStatus{Name: c.Name, State: s})
		}
	}
	for _, c := range pod.Spec.Containers {
		if s, ok := states[c.Name]; ok {
			pod.Status.ContainerStatuses = append(pod.Status.ContainerStatuses, corev1.ContainerStatus{Name: c.Name, State: s})
		}
	}
}

func cond(job *batchv1.Job, t batchv1.JobConditionType, reason string) {
	job.Status.Conditions = append(job.Status.Conditions, batchv1.JobCondition{Type: t, Status: corev1.ConditionTrue, Reason: reason, Message: reason + " message"})
}

func TestTheRenderedPod(t *testing.T) {
	_, pod := build(t, "b1")
	if got := names(pod); !reflect.DeepEqual(got, []string{"checkout", "image", "scan", ReportContainer}) {
		t.Fatalf("containers %v; the fixtures below assume checkout, image, scan, report", got)
	}
}

func TestRead(t *testing.T) {
	ok := done(0, "Completed")
	report := func(msg string) corev1.ContainerState {
		s := done(0, "Completed")
		s.Terminated.Message = msg
		return s
	}
	for _, tc := range []struct {
		name  string
		setup func(*batchv1.Job, *corev1.Pod) *corev1.Pod
		want  Status
	}{
		{"no pod yet", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod { return nil }, Status{State: Pending}},
		{"unschedulable", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable", Message: "0/3 nodes are available"}}
			return p
		}, Status{State: Pending, Step: "checkout", Reason: "Unschedulable", Message: "0/3 nodes are available"}},
		{"checkout image pull back-off", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodPending, map[string]corev1.ContainerState{"checkout": waiting("ImagePullBackOff", "Back-off pulling image")})
			return p
		}, Status{State: Pending, Step: "checkout", Reason: "ImagePullBackOff", Message: "Back-off pulling image"}},
		{"missing Secret", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodPending, map[string]corev1.ContainerState{"checkout": ok, "image": waiting("CreateContainerConfigError", `secret "ci-b1-registry" not found`)})
			return p
		}, Status{State: Running, Step: "image", Reason: "CreateContainerConfigError", Message: `secret "ci-b1-registry" not found`, Stuck: true}},
		{"starting", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodPending, map[string]corev1.ContainerState{"checkout": waiting("PodInitializing", "")})
			return p
		}, Status{State: Pending, Step: "checkout"}},
		{"building", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodPending, map[string]corev1.ContainerState{"checkout": ok, "image": running(), "scan": waiting("PodInitializing", "")})
			return p
		}, Status{State: Running, Step: "image"}}, // the phase is still Pending: init containers
		{"reporting", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodRunning, map[string]corev1.ContainerState{"checkout": ok, "image": ok, "scan": ok, ReportContainer: running()})
			return p
		}, Status{State: Running, Step: ReportContainer}},
		{"succeeded", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodSucceeded, map[string]corev1.ContainerState{"checkout": ok, "image": ok, "scan": ok, ReportContainer: report("image=" + digestA + "\n")})
			cond(j, batchv1.JobSuccessCriteriaMet, batchv1.JobReasonCompletionsReached)
			cond(j, batchv1.JobComplete, batchv1.JobReasonCompletionsReached)
			return p
		}, Status{State: Succeeded, Done: true, Digests: map[string]string{"image": digestA}}},
		{"succeeded, pods still stopping", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodSucceeded, map[string]corev1.ContainerState{ReportContainer: report("image=" + digestA + "\n")})
			cond(j, batchv1.JobSuccessCriteriaMet, batchv1.JobReasonCompletionsReached)
			return p
		}, Status{State: Succeeded, Done: true, Digests: map[string]string{"image": digestA}}},
		{"succeeded, message cut", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodSucceeded, map[string]corev1.ContainerState{ReportContainer: report("image=" + digestA[:40])})
			cond(j, batchv1.JobComplete, "")
			return p
		}, Status{State: Succeeded, Done: true, Digests: map[string]string{}, ReadLog: true}},
		{"succeeded, a build step missing", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodSucceeded, map[string]corev1.ContainerState{ReportContainer: report("other=" + digestB + "\n")})
			cond(j, batchv1.JobComplete, "")
			return p
		}, Status{State: Succeeded, Done: true, Digests: map[string]string{"other": digestB}, ReadLog: true}},
		{"succeeded, message empty", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodSucceeded, map[string]corev1.ContainerState{ReportContainer: report("")})
			cond(j, batchv1.JobComplete, "")
			return p
		}, Status{State: Succeeded, Done: true, Digests: map[string]string{}, ReadLog: true}},
		{"step failed", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodFailed, map[string]corev1.ContainerState{"checkout": ok, "image": done(1, "Error")})
			cond(j, batchv1.JobFailureTarget, batchv1.JobReasonBackoffLimitExceeded)
			return p
		}, Status{State: Failed, Done: true, Step: "image", Reason: "Error", ExitCode: 1, Message: "BackoffLimitExceeded message"}},
		{"step out of memory", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodFailed, map[string]corev1.ContainerState{"checkout": ok, "image": done(137, "OOMKilled")})
			cond(j, batchv1.JobFailed, batchv1.JobReasonBackoffLimitExceeded)
			return p
		}, Status{State: Failed, Done: true, Step: "image", Reason: "OOMKilled", ExitCode: 137, Message: "BackoffLimitExceeded message"}},
		{"failed, Job not told yet", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodFailed, map[string]corev1.ContainerState{"checkout": done(128, "Error")})
			return p
		}, Status{State: Failed, Step: "checkout", Reason: "Error", ExitCode: 128}},
		{"evicted", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodFailed, map[string]corev1.ContainerState{"checkout": ok, "image": running()})
			p.Status.Reason, p.Status.Message = "Evicted", "The node was low on resource: ephemeral-storage."
			cond(j, batchv1.JobFailureTarget, batchv1.JobReasonBackoffLimitExceeded)
			return p
		}, Status{State: Failed, Done: true, Step: "image", Reason: "Evicted", Message: "The node was low on resource: ephemeral-storage."}},
		{"timed out", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodRunning, map[string]corev1.ContainerState{"checkout": ok, "image": running()})
			cond(j, batchv1.JobFailureTarget, batchv1.JobReasonDeadlineExceeded)
			return p
		}, Status{State: TimedOut, Done: true, Step: "image", Reason: "DeadlineExceeded", Message: "DeadlineExceeded message"}},
		{"timed out, pod gone", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			cond(j, batchv1.JobFailed, batchv1.JobReasonDeadlineExceeded)
			return nil
		}, Status{State: TimedOut, Done: true, Reason: "DeadlineExceeded", Message: "DeadlineExceeded message"}},
		{"cancelled", func(j *batchv1.Job, p *corev1.Pod) *corev1.Pod {
			set(p, corev1.PodRunning, map[string]corev1.ContainerState{"checkout": ok, "image": running()})
			j.Annotations[jobspec.CancelAnnotation] = "newer push 89ab"
			return p
		}, Status{State: Cancelled, Done: true, Step: "image", Message: "newer push 89ab"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			job, pod := build(t, "b1")
			got := Read(job, tc.setup(job, pod), []string{"image"})
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got  %+v\nwant %+v", got, tc.want)
			}
		})
	}
}

func TestNoBuildStepsNoDigests(t *testing.T) {
	job, pod := build(t, "b1")
	set(pod, corev1.PodSucceeded, map[string]corev1.ContainerState{ReportContainer: done(0, "Completed")})
	cond(job, batchv1.JobComplete, "")
	if st := Read(job, pod, nil); st.ReadLog || st.Digests != nil || st.State != Succeeded {
		t.Fatalf("%+v", st)
	}
}

// TestTerminationMessageBudget: the kubelet keeps 12 KiB per pod split
// among its containers (pkg/kubelet/status normalizeStatus, v1.37.2), so
// many images in a pod with many containers cut the message; Read must
// then say to read the log.
func TestTerminationMessageBudget(t *testing.T) {
	job, pod := build(t, "b1")
	perContainer := 12 * 1024 / len(names(pod)) // 3072 here
	var steps []string
	var msg strings.Builder
	for i := 0; msg.Len() < perContainer+200; i++ {
		s := fmt.Sprintf("image-%02d", i)
		steps = append(steps, s)
		fmt.Fprintf(&msg, "%s=%s\n", s, digestA)
	}
	cut := msg.String()[:perContainer]
	set(pod, corev1.PodSucceeded, map[string]corev1.ContainerState{ReportContainer: done(0, "Completed")})
	pod.Status.ContainerStatuses[0].State.Terminated.Message = cut
	cond(job, batchv1.JobComplete, "")
	st := Read(job, pod, steps)
	if !st.ReadLog || len(st.Digests) >= len(steps) {
		t.Fatalf("a message cut at %d bytes: ReadLog %v, %d of %d digests", perContainer, st.ReadLog, len(st.Digests), len(steps))
	}
	// The log has every line.
	all, complete := ParseDigests(msg.String())
	if !complete || len(all) != len(steps) {
		t.Fatalf("log lines: %d of %d, complete %v", len(all), len(steps), complete)
	}
}

func TestParseDigests(t *testing.T) {
	for in, want := range map[string]struct {
		n        int
		complete bool
	}{
		"":                        {0, true}, // no image built; Read checks the build steps
		"image=" + digestA + "\n": {1, true},
		"image=" + digestA + "\nweb=" + digestB + "\n": {2, true},
		"image=" + digestA:                   {1, false}, // no final line break: may be cut
		"image=" + digestA[:30] + "\n":       {0, false},
		"Image=" + digestA + "\n":            {0, false},
		"image=sha512:" + digestA[7:] + "\n": {0, false},
		"image=\n":                           {0, false}, // BuildKit wrote no digest
	} {
		got, complete := ParseDigests(in)
		if len(got) != want.n || complete != want.complete {
			t.Errorf("%q: %d digests, complete %v; want %d, %v", in, len(got), complete, want.n, want.complete)
		}
	}
	// Anything at all: never a panic, never a digest of the wrong form.
	r := rand.New(rand.NewPCG(3, 4))
	alphabet := []byte("abc-=\n:sha256" + digestA[7:15])
	for range 2000 {
		b := make([]byte, r.IntN(200))
		for i := range b {
			b[i] = alphabet[r.IntN(len(alphabet))]
		}
		got, _ := ParseDigests(string(b))
		for k, v := range got {
			if !digestLine.MatchString(k + "=" + v) {
				t.Fatalf("%q gave %q=%q", b, k, v)
			}
		}
	}
}

func TestRunningBuildsRestoreTheQueue(t *testing.T) {
	now := time.Date(2026, 11, 1, 19, 0, 0, 0, time.UTC)
	job := func(id, repo, ref string, age time.Duration, change func(*batchv1.Job)) batchv1.Job {
		j, _ := build(t, id)
		j.Annotations[jobspec.AnnotationRepo] = repo
		j.Annotations[jobspec.AnnotationRef] = ref
		j.CreationTimestamp = metav1.NewTime(now.Add(-age))
		if change != nil {
			change(j)
		}
		return *j
	}
	jobs := []batchv1.Job{
		job("b1", "acme/web", "refs/heads/main", 9*time.Minute, nil),
		job("b2", "acme/web", "refs/heads/feature", 8*time.Minute, nil),
		job("b3", "acme/web", "refs/heads/feature", 2*time.Minute, nil), // a newer build of the same branch
		job("b4", "acme/api", "refs/heads/main", 5*time.Minute, func(j *batchv1.Job) { cond(j, batchv1.JobComplete, "") }),
		job("b5", "acme/api", "refs/heads/x", 5*time.Minute, func(j *batchv1.Job) { j.Annotations[jobspec.CancelAnnotation] = "a person" }),
		job("b6", "acme/api", "refs/heads/y", 5*time.Minute, func(j *batchv1.Job) { j.DeletionTimestamp = &metav1.Time{Time: now} }),
		job("b7", "acme/api", "refs/heads/z", 5*time.Minute, func(j *batchv1.Job) { delete(j.Labels, jobspec.LabelBuild) }),
		job("b8", "acme/api", "refs/heads/w", 4*time.Minute, func(j *batchv1.Job) { cond(j, batchv1.JobFailureTarget, batchv1.JobReasonDeadlineExceeded) }),
	}
	builds := RunningBuilds(jobs, func(repo, ref string) bool { return ref == "refs/heads/main" })
	var ids []string
	for _, b := range builds {
		ids = append(ids, b.ID)
		if b.SHA != "0123456789abcdef0123456789abcdef01234567" || b.Enqueued.IsZero() {
			t.Errorf("%s: %+v", b.ID, b)
		}
	}
	if strings.Join(ids, ",") != "b1,b2,b3" || !builds[0].DefaultBranch || builds[1].DefaultBranch {
		t.Fatalf("running builds %v %+v", ids, builds)
	}

	q, err := queue.New(queue.Settings{MaxRunning: 2, MaxPerRepo: 2})
	if err != nil {
		t.Fatal(err)
	}
	d, err := q.Restore(builds)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Cancel) != 1 || d.Cancel[0].ID != "b2" {
		t.Fatalf("restore cancels %+v, want the older feature build b2", d.Cancel)
	}
	// Two run (b1, b3) at the limit: a new build waits, a newer push to main
	// waits too (the running default branch build is kept).
	d, err = q.Submit(queue.Build{ID: "b9", Repo: "acme/api", Ref: "refs/heads/v", SHA: strings.Repeat("9", 40), Enqueued: now})
	if err != nil || len(d.Start) != 0 {
		t.Fatalf("a build past the limit started: %+v %v", d, err)
	}
	if d, err = q.Submit(queue.Build{ID: "b10", Repo: "acme/web", Ref: "refs/heads/main", SHA: strings.Repeat("a", 40), Enqueued: now}); err != nil || len(d.Cancel) != 0 {
		t.Fatalf("the restored default branch build was cancelled: %+v %v", d, err)
	}
	if d, err = q.Submit(queue.Build{ID: "b11", Repo: "acme/web", Ref: "refs/heads/feature", SHA: strings.Repeat("b", 40), Enqueued: now}); err != nil || len(d.Cancel) != 1 || d.Cancel[0].ID != "b3" {
		t.Fatalf("a newer push did not cancel the restored b3: %+v %v", d, err)
	}
}

func TestRestoreRefuses(t *testing.T) {
	b := queue.Build{ID: "b1", Repo: "acme/web", Ref: "refs/heads/main"}
	for name, builds := range map[string][]queue.Build{
		"no ID":   {{Repo: "acme/web", Ref: "refs/heads/main"}},
		"no repo": {{ID: "b1", Ref: "refs/heads/main"}},
		"no ref":  {{ID: "b1", Repo: "acme/web"}},
		"twice":   {b, b},
	} {
		q, _ := queue.New(queue.Settings{})
		if _, err := q.Restore(builds); err == nil {
			t.Errorf("%s: restored", name)
		}
		if run, _ := q.Snapshot(); len(run) != 0 {
			t.Errorf("%s: a refused restore left %d running", name, len(run))
		}
	}
	q, _ := queue.New(queue.Settings{})
	q.Submit(queue.Build{ID: "b0", Repo: "acme/web", Ref: "refs/heads/x", SHA: strings.Repeat("0", 40)})
	if _, err := q.Restore([]queue.Build{b}); err == nil {
		t.Error("restored into a queue in use")
	}
	// Past the limits: all are running, and nothing new starts.
	q, _ = queue.New(queue.Settings{MaxRunning: 1})
	if _, err := q.Restore([]queue.Build{b, {ID: "b2", Repo: "acme/web", Ref: "refs/heads/y"}}); err != nil {
		t.Fatal(err)
	}
	if d, _ := q.Submit(queue.Build{ID: "b3", Repo: "acme/api", Ref: "refs/heads/z", SHA: strings.Repeat("3", 40)}); len(d.Start) != 0 {
		t.Error("a build started past the limit")
	}
	if d := q.Finish("b1"); len(d.Start) != 0 {
		t.Error("one place freed while two ran over a limit of one, and a build started")
	}
	if d := q.Finish("b2"); len(d.Start) != 1 || d.Start[0].ID != "b3" {
		t.Errorf("b3 did not start once places were free: %+v", d)
	}
}
