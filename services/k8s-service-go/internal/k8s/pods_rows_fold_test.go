package k8s

import (
	"context"
	"reflect"
	"runtime"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/anomaly"
)

// narrowingPodMaxBytes is the most the narrowing's pod checks (anomaly_rank) may keep of a pod once it is read.
const narrowingPodMaxBytes = 64

// The narrowing reads a namespace's pods as GetPods' rows one at a time (EachPodRow into anomaly.Pods) and keeps what
// its pod checks read of them, not the rows: GetPods holds them, and those of 50 000 pods held until the answer was made
// took about 300 MiB of k8s-service's 512 Mi. A fifth of the pods here ended in the window or the one before, so the
// terminations kept are counted too. Both read the same rows, so the checks answer the same either way.
func TestTheNarrowingKeepsWhatItsPodChecksReadNotTheRows(t *testing.T) {
	if testing.Short() {
		t.Skip("reads 10 000 pods four times")
	}
	const n = 10000
	end := time.Date(2026, 11, 1, 1, 0, 0, 0, time.UTC)
	w := anomaly.Window{Start: end.Add(-time.Hour), End: end}
	api := &listAPI{}
	for i := range n {
		p := variedPod(i)
		if i%5 == 0 {
			p.Status.ContainerStatuses[0].LastTerminationState.Terminated.FinishedAt = metav1.NewTime(end.Add(-time.Duration(i%90) * time.Minute))
		}
		api.pods = append(api.pods, p)
	}
	s := api.serve(t)
	ctx := context.Background()
	above := func(after, before uint64) uint64 {
		if after < before {
			return 0
		}
		return after - before
	}

	for _, wl := range []*anomaly.Workload{nil, {Kind: "ReplicaSet", Name: "rs-a"}} {
		base := liveHeap()
		rows, err := s.GetPods(ctx, "bulk", "")
		if err != nil {
			t.Fatal(err)
		}
		held := above(liveHeap(), base)
		listed := anomaly.NewPods(wl, w)
		for _, row := range rows {
			listed.Add(row)
		}
		want := []anomaly.CheckResult{anomaly.FromNodeConditions(nil, listed, ""), anomaly.FromCrashReasons(listed)}
		runtime.KeepAlive(rows)

		base = liveHeap()
		pods := anomaly.NewPods(wl, w)
		if err := s.EachPodRow(ctx, "bulk", "", pods.Add); err != nil {
			t.Fatal(err)
		}
		kept := above(liveHeap(), base)
		got := []anomaly.CheckResult{anomaly.FromNodeConditions(nil, pods, ""), anomaly.FromCrashReasons(pods)}
		runtime.KeepAlive(pods)

		t.Logf("workload %+v: GetPods' rows hold %.0f bytes a pod (%.1f MiB), the folded pods %.1f (%.1f KiB)", wl,
			float64(held)/n, float64(held)/(1<<20), float64(kept)/n, float64(kept)/(1<<10))
		if held < 1024*n {
			t.Fatalf("GetPods' rows of %d pods hold %d bytes, less than 1 KiB a pod: the measure does not see them", n, held)
		}
		if float64(kept)/n > narrowingPodMaxBytes {
			t.Errorf("workload %+v: the folded pods keep %.0f bytes a pod, more than %d", wl, float64(kept)/n, narrowingPodMaxBytes)
		}
		if len(want[1].Findings) == 0 {
			t.Fatalf("workload %+v: no termination found, so the answers compared are empty: %+v", wl, want[1])
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("workload %+v: the folded pods answer %+v, GetPods' rows %+v", wl, got, want)
		}
	}
	api.everyPodAskPaged(t)
}
