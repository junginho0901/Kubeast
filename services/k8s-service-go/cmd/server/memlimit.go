package main

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
// took the pod past 512 Mi. setMemoryLimit gives the collector 90 % of the
// cgroup limit, the share the Go GC guide and that proposal suggest, unless
// GOMEMLIMIT is set.
const memoryLimitShare = 0.9

var cgroupMemoryFiles = []string{
	"/sys/fs/cgroup/memory.max",                   // v2
	"/sys/fs/cgroup/memory/memory.limit_in_bytes", // v1
}

func setMemoryLimit() {
	if os.Getenv("GOMEMLIMIT") != "" {
		return
	}
	limit, ok := cgroupMemoryLimit(cgroupMemoryFiles)
	if !ok {
		return
	}
	n := int64(float64(limit) * memoryLimitShare)
	debug.SetMemoryLimit(n)
	slog.Info("memory limit from the container", "cgroup_bytes", limit, "gomemlimit_bytes", n)
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
