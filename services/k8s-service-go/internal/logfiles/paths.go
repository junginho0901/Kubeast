// Package logfiles decides which files inside a container the log files view
// may read. An operator lists path patterns (chart features.logFiles.paths);
// a request names one file, and it is read only when it matches a pattern.
package logfiles

import (
	"fmt"
	"path"
	"sort"
	"strings"
)

// Patterns is a validated list of path patterns: absolute, already clean, with
// glob characters (* and ?) only in the file name, so a pattern never reaches
// outside its directory.
type Patterns struct {
	list []string
}

// Parse validates every pattern and returns the set, or the first error.
func Parse(patterns []string) (Patterns, error) {
	if len(patterns) == 0 {
		return Patterns{}, fmt.Errorf("no log file path patterns")
	}
	seen := map[string]bool{}
	var list []string
	for _, p := range patterns {
		if err := validatePattern(p); err != nil {
			return Patterns{}, err
		}
		if !seen[p] {
			seen[p] = true
			list = append(list, p)
		}
	}
	return Patterns{list: list}, nil
}

func validatePattern(p string) error {
	if !strings.HasPrefix(p, "/") {
		return fmt.Errorf("log file pattern %q: must be an absolute path", p)
	}
	if path.Clean(p) != p || hasDotDot(p) {
		return fmt.Errorf("log file pattern %q: must be a clean path without . or ..", p)
	}
	if strings.ContainsAny(p, "[]\\") || hasControl(p) {
		return fmt.Errorf("log file pattern %q: only * and ? are allowed as wildcards", p)
	}
	dir, name := path.Split(p)
	if name == "" {
		return fmt.Errorf("log file pattern %q: must end in a file name", p)
	}
	if strings.ContainsAny(dir, "*?") {
		return fmt.Errorf("log file pattern %q: wildcards are allowed in the file name only", p)
	}
	return nil
}

// Dirs returns the distinct directories of the patterns, sorted.
func (ps Patterns) Dirs() []string {
	seen := map[string]bool{}
	var dirs []string
	for _, p := range ps.list {
		d := path.Dir(p)
		if !seen[d] {
			seen[d] = true
			dirs = append(dirs, d)
		}
	}
	sort.Strings(dirs)
	return dirs
}

// List returns the patterns as configured.
func (ps Patterns) List() []string { return append([]string(nil), ps.list...) }

// Allowed reports whether p names a file the patterns cover. p must be
// absolute and clean (no . or .. segments, no control characters), and match
// a pattern; path.Match never lets * cross a slash.
func (ps Patterns) Allowed(p string) bool {
	if !strings.HasPrefix(p, "/") || path.Clean(p) != p || hasDotDot(p) || hasControl(p) {
		return false
	}
	for _, pat := range ps.list {
		if ok, err := path.Match(pat, p); err == nil && ok {
			return true
		}
	}
	return false
}

// Match returns the files in dir (one name per entry, as ls -1p prints them:
// directories end in "/") that the patterns cover, as absolute paths, sorted.
func (ps Patterns) Match(dir string, names []string) []string {
	var out []string
	for _, n := range names {
		n = strings.TrimRight(n, "\r")
		if n == "" || strings.HasSuffix(n, "/") || strings.Contains(n, "/") {
			continue
		}
		full := path.Join(dir, n)
		if ps.Allowed(full) {
			out = append(out, full)
		}
	}
	sort.Strings(out)
	return out
}

func hasDotDot(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." || seg == "." {
			return true
		}
	}
	return false
}

func hasControl(p string) bool {
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}
