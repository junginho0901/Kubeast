package memlimit

import (
	"os"
	"path/filepath"
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
		if got := goMemLimit(c.limit, c.reserved); got != c.want {
			t.Errorf("%s: %d, want %d", name, got, c.want)
		}
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
