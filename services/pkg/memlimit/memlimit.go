// Package memlimit gives a Go service's garbage collector the memory limit of its container.
package memlimit

import (
	"log/slog"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
)

// The Go runtime does not read the container's memory limit (Go 1.25 reads
// the CPU limit only; golang/go#75164 proposes the same for memory). Without
// it the garbage collector lets the heap reach twice what is live before it
// runs: 200 people opening Cluster View at once left about 100 MB live and
// took the pod past 512 Mi. Set gives the collector 90 % of the cgroup limit,
// the share the Go GC guide and that proposal suggest, unless GOMEMLIMIT is set.
const memoryLimitShare = 0.9

// A share of the limit stays for the service however much its children take: under it the collector would run all the
// time.
const leastShareOfLimit = 0.25

var cgroupMemoryFiles = []string{
	"/sys/fs/cgroup/memory.max",                   // v2
	"/sys/fs/cgroup/memory/memory.limit_in_bytes", // v1
}

// Set gives the collector its share of the container's limit, less reserved bytes for what else runs in the container
// (kubectl, for tool-server): the runtime knows nothing of a child's memory, and the cgroup counts it.
func Set(reserved int64) {
	if os.Getenv("GOMEMLIMIT") != "" {
		return
	}
	limit, ok := cgroupMemoryLimit(cgroupMemoryFiles)
	if !ok {
		return
	}
	n := goMemLimit(limit, reserved)
	debug.SetMemoryLimit(n)
	slog.Info("memory limit from the container", "cgroup_bytes", limit, "reserved_bytes", reserved, "gomemlimit_bytes", n)
}

func goMemLimit(limit, reserved int64) int64 {
	n := int64(float64(limit)*memoryLimitShare) - reserved
	if least := int64(float64(limit) * leastShareOfLimit); n < least {
		return least
	}
	return n
}

// cgroupMemoryLimit is the first limit set in files; "max" (v2) and the
// v1 no-limit value (near the largest int64) mean none.
func cgroupMemoryLimit(files []string) (int64, bool) {
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		v := strings.TrimSpace(string(b))
		if v == "max" {
			return 0, false
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 || n >= 1<<62 {
			return 0, false
		}
		return n, true
	}
	return 0, false
}
