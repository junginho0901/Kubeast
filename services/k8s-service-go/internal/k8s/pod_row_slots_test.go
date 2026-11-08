package k8s

import (
	"os"
	"runtime"
	"testing"
)

// The callers holding every pod row at once stay few on a big node: as many as the CPUs up to eight, since the chart
// sets no CPU limit and Go then counts every CPU of the node (each place holds about 2 MB of rows on 50 000 pods).
// Run with a large GOMAXPROCS to see it; with eight CPUs or fewer the places are the CPUs.
func TestPodRowPlacesStayFewOnABigNode(t *testing.T) {
	if os.Getenv("POD_ROW_CONCURRENCY") != "" {
		t.Skip("POD_ROW_CONCURRENCY sets the places")
	}
	procs := runtime.GOMAXPROCS(0)
	want := min(procs, 8)
	t.Logf("GOMAXPROCS %d: %d places for the callers holding every pod row", procs, cap(podRowSlots))
	if got := cap(podRowSlots); got != want {
		t.Errorf("%d places with GOMAXPROCS %d, want %d", got, procs, want)
	}
}

// POD_ROW_CONCURRENCY sets the places whatever the CPUs; a value that is no whole number above zero leaves the CPUs up
// to eight.
func TestPodRowPlacesTakeTheirSetting(t *testing.T) {
	for _, c := range []struct {
		setting     string
		procs, want int
	}{{"", 4, 4}, {"", 96, 8}, {"", 0, 1}, {"24", 96, 24}, {"2", 4, 2}, {"0", 96, 8}, {"many", 2, 2}} {
		t.Setenv("POD_ROW_CONCURRENCY", c.setting)
		if got := podRowConcurrency(c.procs); got != c.want {
			t.Errorf("POD_ROW_CONCURRENCY %q with %d CPUs: %d places, want %d", c.setting, c.procs, got, c.want)
		}
	}
}
