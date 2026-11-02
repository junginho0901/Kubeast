package k8s

import (
	"fmt"
	"testing"

	"k8s.io/apimachinery/pkg/api/resource"
)

// kubectl top prints a quantity's MilliValue (rounded up) for CPU, Value()/Mi for memory, and a node's percent as
// int64(used.MilliValue() / allocatable.MilliValue() * 100) (k8s.io/kubectl metricsutil, release-1.37). The cases
// take their expected numbers from resource.Quantity itself.
func TestNodeUsage_AsKubectlTopPrintsIt(t *testing.T) {
	alloc := map[string]nodeAllocatable{"n1": {cpuMilli: 3900, memBytes: 7 << 30}}
	for _, c := range []struct{ cpu, mem string }{
		{"1950000001n", "3758096385"}, // 1951m of 3900m: 50 % (49 % of the 4-core capacity)
		{"1n", "1"},
		{"3899999999n", "7516192767"}, // just under the allocatable
		{"250m", "512Mi"},
		{"1970m", "6656Mi"}, // 50.5 % and 92.9 %: cut to 50 and 92, where rounding would say 51 and 93
	} {
		cpu, mem := resource.MustParse(c.cpu), resource.MustParse(c.mem)
		got := nodeUsage("n1", cpuToNanoCores(c.cpu), memoryToBytes(c.mem), "t", alloc)
		allocCPU, allocMem := resource.MustParse("3900m"), resource.MustParse("7Gi")
		want := map[string]string{
			"cpu":            fmt.Sprintf("%dm", cpu.MilliValue()),
			"memory":         fmt.Sprintf("%dMi", mem.Value()/(1024*1024)),
			"cpu_percent":    fmt.Sprintf("%d%%", int64(float64(cpu.MilliValue())/float64(allocCPU.MilliValue())*100)),
			"memory_percent": fmt.Sprintf("%d%%", int64(float64(mem.MilliValue())/float64(allocMem.MilliValue())*100)),
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("%s/%s: %s = %v, want %s", c.cpu, c.mem, k, got[k], v)
			}
		}
	}
	if got := nodeUsage("n2", 1, 1, "t", alloc); got["cpu_percent"] != nil || got["memory_percent"] != nil {
		t.Errorf("a node without allocatable has no percent: %v", got)
	}
}

func TestTopMillicores_RoundsUpAsMilliValue(t *testing.T) {
	for _, n := range []int64{0, 1, 999_999, 1_000_000, 1_000_001, 1_950_000_001} {
		q := resource.NewScaledQuantity(n, resource.Nano)
		if got := topMillicores(n); got != q.MilliValue() {
			t.Errorf("%dn: %d, want %d", n, got, q.MilliValue())
		}
	}
}
