package main

import (
	"os"
	"path/filepath"
	"testing"
)

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
