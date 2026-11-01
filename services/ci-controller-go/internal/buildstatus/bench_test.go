package buildstatus

import (
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
)

// BenchmarkRead decides a finished build with two digests, as the
// controller does on every Job and pod change.
func BenchmarkRead(b *testing.B) {
	job, pod := build(b, "b1")
	s := done(0, "Completed")
	s.Terminated.Message = "image=" + digestA + "\nweb=" + digestB + "\n"
	set(pod, corev1.PodSucceeded, map[string]corev1.ContainerState{"checkout": done(0, "Completed"), "image": done(0, "Completed"), "scan": done(0, "Completed"), ReportContainer: s})
	cond(job, batchv1.JobComplete, batchv1.JobReasonCompletionsReached)
	steps := []string{"image", "web"}
	b.ReportAllocs()
	for b.Loop() {
		if st := Read(job, pod, steps); st.State != Succeeded || st.ReadLog {
			b.Fatal(st)
		}
	}
}

// TestReadAllocs caps what one Read allocates: 5 with one digest (7 with
// the benchmark's two), on go1.26.0 and 1.27.3.
func TestReadAllocs(t *testing.T) {
	job, pod := build(t, "b1")
	s := done(0, "Completed")
	s.Terminated.Message = "image=" + digestA + "\n"
	set(pod, corev1.PodSucceeded, map[string]corev1.ContainerState{ReportContainer: s})
	cond(job, batchv1.JobComplete, "")
	n := testing.AllocsPerRun(50, func() { Read(job, pod, []string{"image"}) })
	t.Logf("Read: %.0f allocations", n)
	if n > 12 {
		t.Errorf("Read allocated %.0f times, above 12", n)
	}
}
