package job

import (
	"fmt"
	"math/rand"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// kubectlPrintJob is printJob of Kubernetes v1.37.2 (pkg/printers/internalversion/printers.go, Apache-2.0) with
// hasJobCondition, over the public API's types, for the STATUS and COMPLETIONS cells.
func kubectlPrintJob(obj *batchv1.Job) (status, completions string) {
	if obj.Spec.Completions != nil {
		completions = fmt.Sprintf("%d/%d", obj.Status.Succeeded, *obj.Spec.Completions)
	} else {
		parallelism := int32(0)
		if obj.Spec.Parallelism != nil {
			parallelism = *obj.Spec.Parallelism
		}
		if parallelism > 1 {
			completions = fmt.Sprintf("%d/1 of %d", obj.Status.Succeeded, parallelism)
		} else {
			completions = fmt.Sprintf("%d/1", obj.Status.Succeeded)
		}
	}
	if kubectlHasJobCondition(obj.Status.Conditions, batchv1.JobComplete) {
		status = "Complete"
	} else if kubectlHasJobCondition(obj.Status.Conditions, batchv1.JobFailed) {
		status = "Failed"
	} else if obj.ObjectMeta.DeletionTimestamp != nil {
		status = "Terminating"
	} else if kubectlHasJobCondition(obj.Status.Conditions, batchv1.JobSuspended) {
		status = "Suspended"
	} else if kubectlHasJobCondition(obj.Status.Conditions, batchv1.JobFailureTarget) {
		status = "FailureTarget"
	} else if kubectlHasJobCondition(obj.Status.Conditions, batchv1.JobSuccessCriteriaMet) {
		status = "SuccessCriteriaMet"
	} else {
		status = "Running"
	}
	return status, completions
}

func kubectlHasJobCondition(conditions []batchv1.JobCondition, conditionType batchv1.JobConditionType) bool {
	for _, condition := range conditions {
		if condition.Type == conditionType {
			return condition.Status == corev1.ConditionTrue
		}
	}
	return false
}

func withConditions(conds ...batchv1.JobCondition) *batchv1.Job {
	return &batchv1.Job{Status: batchv1.JobStatus{Conditions: conds}}
}

func isTrue(t batchv1.JobConditionType) batchv1.JobCondition {
	return batchv1.JobCondition{Type: t, Status: corev1.ConditionTrue}
}

func isFalse(t batchv1.JobConditionType) batchv1.JobCondition {
	return batchv1.JobCondition{Type: t, Status: corev1.ConditionFalse}
}

func being(j *batchv1.Job) *batchv1.Job {
	gone := metav1.NewTime(time.Unix(1_700_000_000, 0))
	j.DeletionTimestamp = &gone
	return j
}

// Written out by hand: a port of kubectl's function that went wrong would pass the sweep below.
func TestStatusReadsAsKubectlPrintsIt(t *testing.T) {
	cases := []struct {
		name string
		job  *batchv1.Job
		want string
	}{
		{"no condition", withConditions(), "Running"},
		{"Complete", withConditions(isTrue(batchv1.JobComplete)), "Complete"},
		{"Complete not true", withConditions(isFalse(batchv1.JobComplete)), "Running"},
		{"Failed", withConditions(isTrue(batchv1.JobFailed)), "Failed"},
		{"Failed not true", withConditions(isFalse(batchv1.JobFailed)), "Running"},
		{"Suspended", withConditions(isTrue(batchv1.JobSuspended)), "Suspended"},
		{"resumed, its Suspended condition false", withConditions(isFalse(batchv1.JobSuspended)), "Running"},
		{"on its way to Failed", withConditions(isTrue(batchv1.JobFailureTarget)), "FailureTarget"},
		{"on its way to Complete", withConditions(isTrue(batchv1.JobSuccessCriteriaMet)), "SuccessCriteriaMet"},
		{"being deleted", being(withConditions()), "Terminating"},
		{"being deleted and suspended", being(withConditions(isTrue(batchv1.JobSuspended))), "Terminating"},
		{"being deleted, already Complete", being(withConditions(isTrue(batchv1.JobComplete))), "Complete"},
		{"being deleted, already Failed", being(withConditions(isTrue(batchv1.JobFailed))), "Failed"},
		{"Complete goes before Failed, whichever is first", withConditions(isTrue(batchv1.JobFailed), isTrue(batchv1.JobComplete)), "Complete"},
		{"Complete goes before SuccessCriteriaMet", withConditions(isTrue(batchv1.JobSuccessCriteriaMet), isTrue(batchv1.JobComplete)), "Complete"},
		{"Failed goes before FailureTarget", withConditions(isTrue(batchv1.JobFailureTarget), isTrue(batchv1.JobFailed)), "Failed"},
		{"Suspended goes before FailureTarget", withConditions(isTrue(batchv1.JobFailureTarget), isTrue(batchv1.JobSuspended)), "Suspended"},
		{"FailureTarget goes before SuccessCriteriaMet", withConditions(isTrue(batchv1.JobSuccessCriteriaMet), isTrue(batchv1.JobFailureTarget)), "FailureTarget"},
		{"the first condition of a type decides", withConditions(isFalse(batchv1.JobComplete), isTrue(batchv1.JobComplete)), "Running"},
	}
	for _, c := range cases {
		if got := Info(c.job)["status"]; got != c.want {
			t.Errorf("%s: status %q, want %q", c.name, got, c.want)
		}
		if got, _ := kubectlPrintJob(c.job); got != c.want {
			t.Errorf("%s: the port of kubectl's function gives %q, want %q", c.name, got, c.want)
		}
	}
}

func TestCompletionsReadAsKubectlPrintsThem(t *testing.T) {
	n := func(v int32) *int32 { return &v }
	cases := []struct {
		name                     string
		completions, parallelism *int32
		succeeded                int32
		want                     string
	}{
		{"neither set", nil, nil, 0, "0/1"},
		{"one wanted", n(1), n(1), 0, "0/1"},
		{"several wanted", n(5), n(2), 3, "3/5"},
		{"none wanted", n(0), n(1), 0, "0/0"},
		{"a work queue of three", nil, n(3), 0, "0/1 of 3"},
		{"a work queue of three with one done", nil, n(3), 1, "1/1 of 3"},
		{"parallelism one with no completions", nil, n(1), 0, "0/1"},
		{"parallelism zero with no completions", nil, n(0), 0, "0/1"},
		{"completions set, parallel", n(1), n(3), 0, "0/1"},
	}
	for _, c := range cases {
		j := &batchv1.Job{Spec: batchv1.JobSpec{Completions: c.completions, Parallelism: c.parallelism}, Status: batchv1.JobStatus{Succeeded: c.succeeded}}
		if got := Info(j)["completions_text"]; got != c.want {
			t.Errorf("%s: completions_text %v, want %q", c.name, got, c.want)
		}
		if _, got := kubectlPrintJob(j); got != c.want {
			t.Errorf("%s: the port of kubectl's function gives %q, want %q", c.name, got, c.want)
		}
	}
}

func TestStatusAndCompletionsAreKubectlsForEveryMixOfConditions(t *testing.T) {
	rng := rand.New(rand.NewSource(13))
	types := []batchv1.JobConditionType{batchv1.JobComplete, batchv1.JobFailed, batchv1.JobSuspended, batchv1.JobFailureTarget, batchv1.JobSuccessCriteriaMet}
	statuses := []corev1.ConditionStatus{corev1.ConditionTrue, corev1.ConditionTrue, corev1.ConditionFalse, corev1.ConditionUnknown}
	counts := []*int32{nil, new(int32), ptr(1), ptr(3)}
	seen := map[string]int{}
	for i := 0; i < 5000; i++ {
		j := &batchv1.Job{Spec: batchv1.JobSpec{Completions: counts[rng.Intn(len(counts))], Parallelism: counts[rng.Intn(len(counts))]}, Status: batchv1.JobStatus{Succeeded: int32(rng.Intn(3))}}
		for n := rng.Intn(4); n > 0; n-- {
			j.Status.Conditions = append(j.Status.Conditions, batchv1.JobCondition{Type: types[rng.Intn(len(types))], Status: statuses[rng.Intn(len(statuses))]})
		}
		if rng.Intn(6) == 0 {
			being(j)
		}
		wantStatus, wantCompletions := kubectlPrintJob(j)
		seen[wantStatus]++
		row := Info(j)
		if row["status"] != wantStatus {
			t.Fatalf("%+v: status %q, kubectl prints %q", j.Status.Conditions, row["status"], wantStatus)
		}
		if row["completions_text"] != wantCompletions {
			t.Fatalf("%+v: completions_text %v, kubectl prints %q", j.Spec, row["completions_text"], wantCompletions)
		}
	}
	for _, s := range []string{"Running", "Complete", "Failed", "Terminating", "Suspended", "FailureTarget", "SuccessCriteriaMet"} {
		if seen[s] == 0 {
			t.Errorf("the sweep never reached %s: %v", s, seen)
		}
	}
}

func ptr(v int32) *int32 { return &v }
