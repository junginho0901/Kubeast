package source

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
)

// MaxFileSize caps one file of a bundle; a larger one is refused rather
// than read whole into memory.
const MaxFileSize = 1 << 20

var name = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// FS reads the layout from a file system: a commit's tree (Repo.Snapshot,
// read from git's objects without a checkout), a folder on disk, or an
// fstest.MapFS in tests.
type FS struct {
	fsys     fs.FS
	revision string
}

// NewFS reads fsys; revision is what it holds (a commit, or "" if unknown).
func NewFS(fsys fs.FS, revision string) *FS {
	return &FS{fsys: fsys, revision: revision}
}

// Services lists the folders under services/ that hold a score.yaml.
// Folders starting with "." or "_" are not workloads; any other name that
// is not a DNS label is an error, so a workload is never left out unseen.
func (s *FS) Services(ctx context.Context) ([]string, error) {
	return s.list("services", "score.yaml")
}

// Environments lists the folders under environments/ that hold _defaults.yaml.
func (s *FS) Environments(ctx context.Context) ([]string, error) {
	return s.list("environments", "_defaults.yaml")
}

func (s *FS) list(dir, marker string) ([]string, error) {
	entries, err := fs.ReadDir(s.fsys, dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	var bad, links []string
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, ".") || strings.HasPrefix(n, "_") {
			continue
		}
		if e.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			links = append(links, n)
			continue
		}
		if !e.IsDir() {
			continue
		}
		if !name.MatchString(n) || len(n) > 63 {
			bad = append(bad, n)
			continue
		}
		if _, err := fs.Stat(s.fsys, path.Join(dir, n, marker)); err == nil {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	var errs []error
	if len(bad) > 0 {
		sort.Strings(bad)
		errs = append(errs, fmt.Errorf("%s: folder names %q are not DNS labels", dir, bad))
	}
	if len(links) > 0 {
		sort.Strings(links)
		errs = append(errs, fmt.Errorf("%s: %q are links or submodules, which are not followed", dir, links))
	}
	return out, errors.Join(errs...)
}

// Load reads one workload in one environment.
func (s *FS) Load(ctx context.Context, service, env string) (*Bundle, error) {
	if !name.MatchString(service) || len(service) > 63 {
		return nil, fmt.Errorf("service %q is not a DNS label", service)
	}
	if !name.MatchString(env) || len(env) > 63 {
		return nil, fmt.Errorf("environment %q is not a DNS label", env)
	}
	b := &Bundle{Service: service, Env: env, Revision: s.revision}
	var err error
	svcDir := path.Join("services", service)
	if b.Score, err = s.read(path.Join(svcDir, "score.yaml"), true); err != nil {
		return nil, err
	}
	envDir := path.Join("environments", env)
	if b.Defaults, err = s.read(path.Join(envDir, "_defaults.yaml"), true); err != nil {
		return nil, err
	}
	if b.Overrides, err = s.read(path.Join(envDir, service+".score.yaml"), false); err != nil {
		return nil, err
	}
	if b.Patches, err = s.readDir(path.Join(svcDir, "patches"), ".yaml", ".yml"); err != nil {
		return nil, err
	}
	if b.Raw, err = s.readDir(path.Join(svcDir, "raw"), ".yaml", ".yml"); err != nil {
		return nil, err
	}
	if b.Policies, err = s.readDir("policies", ".rego"); err != nil {
		return nil, err
	}
	if b.Files, err = fs.Sub(s.fsys, svcDir); err != nil {
		return nil, err
	}
	return b, nil
}

// File reads one file of the layout, within MaxFileSize; a missing file is
// ErrNotFound.
func (s *FS) File(p string) ([]byte, error) {
	if !fs.ValidPath(p) {
		return nil, fmt.Errorf("path %q is not a clean relative path", p)
	}
	return s.read(p, true)
}

func (s *FS) read(p string, required bool) ([]byte, error) {
	st, err := fs.Stat(s.fsys, p)
	if errors.Is(err, fs.ErrNotExist) {
		if required {
			return nil, fmt.Errorf("%s: %w", p, ErrNotFound)
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if st.IsDir() {
		return nil, fmt.Errorf("%s is a folder", p)
	}
	if st.Size() > MaxFileSize {
		return nil, fmt.Errorf("%s: %d bytes, above the %d-byte limit", p, st.Size(), MaxFileSize)
	}
	return fs.ReadFile(s.fsys, p)
}

// readDir reads the files of a folder with the given extensions, by name.
func (s *FS) readDir(dir string, exts ...string) ([]File, error) {
	entries, err := fs.ReadDir(s.fsys, dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []File
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		ok := false
		for _, x := range exts {
			ok = ok || strings.HasSuffix(e.Name(), x)
		}
		if !ok {
			continue
		}
		p := path.Join(dir, e.Name())
		data, err := s.read(p, true)
		if err != nil {
			return nil, err
		}
		out = append(out, File{Name: p, Data: data})
	}
	return out, nil
}
