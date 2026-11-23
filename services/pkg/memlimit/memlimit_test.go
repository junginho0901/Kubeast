package memlimit

import (
	"os"
	"path/filepath"
	"runtime/debug"
	"testing"
)

// The collector gets 90 % of the limit, less what else runs in the container, and never so little that it runs all the
// time: 256 Mi with three kubectl of 40 MiB is about 110 MiB, with none about 230 MiB.
func TestGoMemLimit(t *testing.T) {
	const mi = int64(1) << 20
	for name, c := range map[string]struct{ limit, reserved, want int64 }{
		"k8s-service, 512 Mi":             {512 * mi, 0, 483183820},
		"a service of 256 Mi":             {256 * mi, 0, 241591910},
		"tool-server, 256 Mi and kubectl": {256 * mi, 120 * mi, 241591910 - 120*mi},
		"a limit kubectl would take all":  {128 * mi, 120 * mi, 32 * mi},
	} {
		if got := goMemLimitShare(c.limit, memoryLimitShare, c.reserved); got != c.want {
			t.Errorf("%s: %d, want %d", name, got, c.want)
		}
	}
}

// k8s-service's 85 % leaves the kernel's memory for its sockets 76.8 MiB of 512 Mi; reserved bytes and the floor work as
// at 90 %.
func TestGoMemLimitShare(t *testing.T) {
	const mi = int64(1) << 20
	for name, c := range map[string]struct {
		limit    int64
		share    float64
		reserved int64
		want     int64
	}{
		"k8s-service, 512 Mi":             {512 * mi, 0.85, 0, 456340275},
		"k8s-service, 1 Gi":               {1024 * mi, 0.85, 0, 912680550},
		"less reserved bytes":             {512 * mi, 0.85, 48 * mi, 456340275 - 48*mi},
		"a limit reserved bytes take all": {128 * mi, 0.85, 120 * mi, 32 * mi},
		"the other services' 90 %":        {512 * mi, memoryLimitShare, 0, 483183820},
	} {
		if got := goMemLimitShare(c.limit, c.share, c.reserved); got != c.want {
			t.Errorf("%s: %d, want %d", name, got, c.want)
		}
	}
}

// A GOMEMLIMIT in the environment is the limit: SetShare leaves it, and without it sets the share of the cgroup's.
func TestSetShareLeavesAGOMEMLIMITFromTheEnvironment(t *testing.T) {
	file := filepath.Join(t.TempDir(), "memory.max")
	if err := os.WriteFile(file, []byte("536870912\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	files := cgroupMemoryFiles
	cgroupMemoryFiles = []string{file}
	was := debug.SetMemoryLimit(-1)
	t.Cleanup(func() {
		cgroupMemoryFiles = files
		debug.SetMemoryLimit(was)
	})

	t.Setenv("GOMEMLIMIT", "300MiB")
	SetShare(0.85, 0)
	if got := debug.SetMemoryLimit(-1); got != was {
		t.Fatalf("with GOMEMLIMIT set the limit went from %d to %d", was, got)
	}
	t.Setenv("GOMEMLIMIT", "")
	SetShare(0.85, 0)
	if got := debug.SetMemoryLimit(-1); got != 456340275 {
		t.Fatalf("without GOMEMLIMIT the limit is %d, want 85 %% of 512 Mi, 456340275", got)
	}
}

// The first cgroup file that exists decides: a number is the limit, "max" and the v1 no-limit value are none.
func TestCgroupMemoryLimit(t *testing.T) {
	dir := t.TempDir()
	write := func(name, v string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(v), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	v2 := write("v2", "536870912\n")
	unlimited := write("max", "max\n")
	v1None := write("v1none", "9223372036854771712\n")
	v1 := write("v1", "1073741824\n")
	missing := filepath.Join(dir, "missing")

	for name, c := range map[string]struct {
		files []string
		want  int64
		ok    bool
	}{
		"v2":                 {[]string{v2, v1}, 536870912, true},
		"v1 when v2 missing": {[]string{missing, v1}, 1073741824, true},
		"v2 max":             {[]string{unlimited, v1}, 0, false},
		"v1 no limit":        {[]string{missing, v1None}, 0, false},
		"neither":            {[]string{missing}, 0, false},
	} {
		got, ok := cgroupMemoryLimit(c.files)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: %d %v, want %d %v", name, got, ok, c.want, c.ok)
		}
	}
}
