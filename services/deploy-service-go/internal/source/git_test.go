package source

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

// The remote side of these tests is made by the real git, so the git source
// reads what git writes; go-git's file transport also runs git-upload-pack.

type remote struct {
	work string // a checkout that pushes to bare
	bare string
}

func gitEnv(t testing.TB) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Fatal("these tests need git on PATH")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	for k, v := range map[string]string{
		"GIT_AUTHOR_NAME": "a", "GIT_AUTHOR_EMAIL": "a@example.com",
		"GIT_COMMITTER_NAME": "c", "GIT_COMMITTER_EMAIL": "c@example.com",
		"GIT_AUTHOR_DATE": "2026-11-01T12:00:00Z", "GIT_COMMITTER_DATE": "2026-11-01T12:00:00Z",
	} {
		t.Setenv(k, v)
	}
}

func gitRun(t testing.TB, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.symlinks=true"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// newRemote makes a bare repository whose main holds the plan package's
// sample layout, and a checkout of it.
func newRemote(t testing.TB) *remote {
	t.Helper()
	gitEnv(t)
	r := &remote{work: t.TempDir(), bare: t.TempDir()}
	gitRun(t, r.bare, "init", "--bare")
	gitRun(t, r.work, "init")
	gitRun(t, r.work, "remote", "add", "origin", r.bare)
	if err := os.CopyFS(r.work, os.DirFS("../plan/testdata/repo")); err != nil {
		t.Fatal(err)
	}
	r.commit(t, "layout", nil)
	return r
}

// commit writes files (an empty value removes one), commits everything and
// pushes the branch it is on; it returns the commit.
func (r *remote) commit(t testing.TB, msg string, files map[string]string) string {
	t.Helper()
	for name, data := range files {
		p := filepath.Join(r.work, filepath.FromSlash(name))
		if data == "" {
			if err := os.RemoveAll(p); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	gitRun(t, r.work, "add", "-A")
	gitRun(t, r.work, "commit", "-q", "--allow-empty", "-m", msg)
	gitRun(t, r.work, "push", "-q", "origin", "HEAD")
	return gitRun(t, r.work, "rev-parse", "HEAD")
}

func (r *remote) open(t testing.TB, o RepoOptions) *Repo {
	t.Helper()
	o.URL, o.AllowLocal = r.bare, true
	repo, err := OpenRepo(t.TempDir(), o)
	if err != nil {
		t.Fatal(err)
	}
	return repo
}

func fetch(t testing.TB, repo *Repo, ref Ref) string {
	t.Helper()
	c, err := repo.Fetch(context.Background(), ref)
	if err != nil {
		t.Fatalf("fetch %+v: %v", ref, err)
	}
	return c
}

func snapshot(t testing.TB, repo *Repo, commit, dir string) *FS {
	t.Helper()
	s, err := repo.Snapshot(commit, dir)
	if err != nil {
		t.Fatalf("snapshot %s %q: %v", commit, dir, err)
	}
	return s
}

// sameBundles fails unless got reads what want reads, file sources included.
func sameBundles(t *testing.T, got, want *FS) {
	t.Helper()
	ctx := context.Background()
	gs, err1 := got.Services(ctx)
	ws, err2 := want.Services(ctx)
	ge, err3 := got.Environments(ctx)
	we, err4 := want.Environments(ctx)
	if err := errors.Join(err1, err2, err3, err4); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gs, ws) || !reflect.DeepEqual(ge, we) || len(gs) == 0 || len(ge) == 0 {
		t.Fatalf("services %q environments %q, want %q %q", gs, ge, ws, we)
	}
	for _, svc := range gs {
		for _, env := range ge {
			g, err1 := got.Load(ctx, svc, env)
			w, err2 := want.Load(ctx, svc, env)
			if err := errors.Join(err1, err2); err != nil {
				t.Fatal(err)
			}
			if g.Revision != got.revision {
				t.Errorf("%s/%s revision %q, want %q", svc, env, g.Revision, got.revision)
			}
			gf, wf := filesOf(t, g.Files), filesOf(t, w.Files)
			g.Files, w.Files, g.Revision, w.Revision = nil, nil, "", ""
			if !reflect.DeepEqual(g, w) {
				t.Errorf("%s/%s:\n got %+v\nwant %+v", svc, env, g, w)
			}
			if !reflect.DeepEqual(gf, wf) || len(gf) == 0 {
				t.Errorf("%s/%s files %v, want %v", svc, env, gf, wf)
			}
		}
	}
}

func filesOf(t *testing.T, fsys fs.FS) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(fsys, p)
		out[p] = string(b)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestGitBranchReadsAsTheCheckout(t *testing.T) {
	r := newRemote(t)
	repo := r.open(t, RepoOptions{Depth: 1})
	c := fetch(t, repo, Ref{Branch: "main"})
	if want := gitRun(t, r.bare, "rev-parse", "main"); c != want {
		t.Fatalf("commit %s, want %s", c, want)
	}
	sameBundles(t, snapshot(t, repo, c, ""), NewFS(os.DirFS(r.work), c))

	// The same layout under a folder, read from there.
	if err := os.CopyFS(filepath.Join(r.work, "deploy"), os.DirFS("../plan/testdata/repo")); err != nil {
		t.Fatal(err)
	}
	c2 := r.commit(t, "deploy folder", nil)
	if got := fetch(t, repo, Ref{Branch: "main"}); got != c2 {
		t.Fatalf("commit %s, want %s", got, c2)
	}
	sameBundles(t, snapshot(t, repo, c2, "deploy/"), NewFS(os.DirFS(filepath.Join(r.work, "deploy")), c2))
	for dir, want := range map[string]error{"missing": ErrNotFound, "deploy/../x": nil, "services/web/score.yaml": nil, "/..": nil} {
		_, err := repo.Snapshot(c2, dir)
		if err == nil || (want != nil && !errors.Is(err, want)) {
			t.Errorf("snapshot %q: %v, want an error (%v)", dir, err, want)
		}
	}
}

// TestGitTreeAsLsTree compares the snapshot's file system with what git
// lists for the commit: every entry, its kind and its size.
func TestGitTreeAsLsTree(t *testing.T) {
	r := newRemote(t)
	sub := gitRun(t, r.work, "rev-parse", "HEAD")
	r.commit(t, "kinds", map[string]string{
		"bin/run.sh":           "#!/bin/sh\necho run\n",
		"deep/a/b/c/d.txt":     "deep\n",
		"deep/a.txt":           "git sorts this before the folder a\n",
		"empty.txt":            "\x00",
		"services/web/x.json":  "{}\n",
		"services/web/raw/z.y": "kind: x\n",
	})
	gitRun(t, r.work, "update-index", "--chmod=+x", "bin/run.sh")
	if err := os.Symlink("../services/web", filepath.Join(r.work, "deep", "web-link")); err != nil {
		t.Fatal(err)
	}
	gitRun(t, r.work, "add", "deep/web-link")
	gitRun(t, r.work, "update-index", "--add", "--cacheinfo", "160000,"+sub+",vendor/lib")
	gitRun(t, r.work, "commit", "-q", "-m", "link and submodule")
	gitRun(t, r.work, "push", "-q", "origin", "HEAD")
	c := gitRun(t, r.work, "rev-parse", "HEAD")

	repo := r.open(t, RepoOptions{})
	fetch(t, repo, Ref{Branch: "main"})
	fsys := snapshot(t, repo, c, "").fsys

	var want []string
	for _, line := range strings.Split(gitRun(t, r.work, "ls-tree", "-r", "-t", "-l", "--full-tree", c), "\n") {
		meta, name, _ := strings.Cut(line, "\t")
		f := strings.Fields(meta) // mode type object size
		kind := map[string]string{"040000": "dir", "100644": "file", "100755": "exec", "120000": "link", "160000": "other"}[f[0]]
		size := f[3]
		if size == "-" {
			size = "0"
		}
		want = append(want, name+" "+kind+" "+size)
	}
	var got []string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			entries, err := fs.ReadDir(fsys, p)
			names := make([]string, len(entries))
			for i, e := range entries {
				names[i] = e.Name()
			}
			if err != nil || !sort.StringsAreSorted(names) {
				t.Errorf("%s lists %q (%v), want them sorted by name", p, names, err)
			}
		}
		if p == "." {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		st, err := fs.Stat(fsys, p)
		if err != nil {
			return err
		}
		if st.Mode() != info.Mode() || st.Size() != info.Size() || st.Name() != d.Name() {
			t.Errorf("%s: Stat %v %d %s, ReadDir %v %d %s", p, st.Mode(), st.Size(), st.Name(), info.Mode(), info.Size(), d.Name())
		}
		kind := "file"
		switch m := info.Mode(); {
		case m.IsDir():
			kind = "dir"
		case m&fs.ModeSymlink != 0:
			kind = "link"
		case m&fs.ModeIrregular != 0:
			kind = "other"
		case m.Perm()&0o100 != 0:
			kind = "exec"
		}
		got = append(got, p+" "+kind+" "+strconv.FormatInt(info.Size(), 10))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot lists\n%s\ngit lists\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	for p, wantData := range map[string]string{"bin/run.sh": "#!/bin/sh\necho run\n", "empty.txt": "\x00", "deep/a/b/c/d.txt": "deep\n"} {
		if b, err := fs.ReadFile(fsys, p); err != nil || string(b) != wantData {
			t.Errorf("%s: %q %v", p, b, err)
		}
	}
	for _, p := range []string{"deep/web-link", "vendor/lib"} {
		if _, err := fs.ReadFile(fsys, p); !errors.Is(err, errNotFollowed) {
			t.Errorf("%s: %v, want %v", p, err, errNotFollowed)
		}
		if _, err := fs.ReadDir(fsys, p); err == nil {
			t.Errorf("%s: read as a folder", p)
		}
	}
	if _, err := fs.ReadFile(fsys, "deep/web-link/score.yaml"); err == nil {
		t.Error("a path through a link was read")
	}
}

func TestGitFSConformance(t *testing.T) {
	r := newRemote(t)
	repo := r.open(t, RepoOptions{})
	c := fetch(t, repo, Ref{Branch: "main"})
	fsys := snapshot(t, repo, c, "").fsys
	want := []string{}
	for p := range filesOf(t, os.DirFS("../plan/testdata/repo")) {
		want = append(want, p)
	}
	if err := fstest.TestFS(fsys, want...); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"/services", "services/", "./services", "services/../policies", ""} {
		if _, err := fsys.Open(bad); !errors.Is(err, fs.ErrInvalid) {
			t.Errorf("open %q: %v, want %v", bad, err, fs.ErrInvalid)
		}
	}
	if _, err := fsys.Open("services/none"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("open a missing file: %v", err)
	}
	if _, err := fs.ReadDir(fsys, "services/web/score.yaml"); err == nil {
		t.Error("read a file as a folder")
	}
}

// TestGitLinksAreNotFollowed: a workload behind a link or a submodule is an
// error, never left out unseen, and a link is never read through.
func TestGitLinksAreNotFollowed(t *testing.T) {
	r := newRemote(t)
	sub := gitRun(t, r.work, "rev-parse", "HEAD")
	for link, target := range map[string]string{
		"services/alias":                   "web",
		"services/web/patches/x.yaml":      "../../../../../etc/passwd",
		"environments/beta":                "alpha",
		"services/api/patches/a.yaml":      "/etc/hostname",
		"environments/prod/api.score.yaml": "../alpha/web.score.yaml",
	} {
		p := filepath.Join(r.work, filepath.FromSlash(link))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, p); err != nil {
			t.Fatal(err)
		}
	}
	gitRun(t, r.work, "add", "-A")
	gitRun(t, r.work, "update-index", "--add", "--cacheinfo", "160000,"+sub+",services/sub")
	gitRun(t, r.work, "commit", "-q", "-m", "links")
	gitRun(t, r.work, "push", "-q", "origin", "HEAD")

	repo := r.open(t, RepoOptions{})
	c := fetch(t, repo, Ref{Branch: "main"})
	ctx := context.Background()
	for name, src := range map[string]*FS{"git": snapshot(t, repo, c, ""), "disk": NewFS(os.DirFS(r.work), c)} {
		svcs, err := src.Services(ctx)
		if err == nil || !strings.Contains(err.Error(), `"alias"`) || !reflect.DeepEqual(svcs, []string{"api", "web"}) {
			t.Errorf("%s services %q: %v", name, svcs, err)
		}
		if name == "git" && !strings.Contains(err.Error(), `"sub"`) {
			t.Errorf("%s services: %v, want the submodule named", name, err)
		}
		envs, err := src.Environments(ctx)
		if err == nil || !strings.Contains(err.Error(), `"beta"`) || !reflect.DeepEqual(envs, []string{"alpha", "prod"}) {
			t.Errorf("%s environments %q: %v", name, envs, err)
		}
		if name == "git" {
			for _, pair := range [][2]string{{"web", "alpha"}, {"api", "alpha"}, {"api", "prod"}} {
				if _, err := src.Load(ctx, pair[0], pair[1]); !errors.Is(err, errNotFollowed) {
					t.Errorf("load %v: %v, want %v", pair, err, errNotFollowed)
				}
			}
		}
	}
}

func TestGitTagsAndCommits(t *testing.T) {
	r := newRemote(t)
	c1 := gitRun(t, r.work, "rev-parse", "HEAD")
	gitRun(t, r.work, "tag", "v1")
	c2 := r.commit(t, "two", map[string]string{"services/web/motd.txt": "two\n"})
	gitRun(t, r.work, "tag", "-a", "v2", "-m", "two")
	gitRun(t, r.work, "tag", "-a", "v2-signed-off", "-m", "tag of a tag", "v2")
	gitRun(t, r.work, "push", "-q", "origin", "--tags")
	gitRun(t, r.work, "checkout", "-q", "-b", "other", c1)
	c3 := r.commit(t, "other", map[string]string{"services/web/motd.txt": "other\n"})
	gitRun(t, r.work, "checkout", "-q", "main")

	repo := r.open(t, RepoOptions{Depth: 1})
	for _, tc := range []struct {
		ref  Ref
		want string
	}{
		{Ref{Tag: "v1"}, c1},
		{Ref{Tag: "v2"}, c2},
		{Ref{Tag: "v2-signed-off"}, c2},
		{Ref{Branch: "main"}, c2},
		{Ref{Branch: "main", Tag: "v1"}, c1},
		{Ref{Branch: "main", Commit: c1}, c1},
		{Ref{Tag: "v2", Commit: c3}, c3},
		{Ref{Commit: c3}, c3},
		{Ref{Branch: "other"}, c3},
	} {
		if got := fetch(t, repo, tc.ref); got != tc.want {
			t.Errorf("%+v: %s, want %s", tc.ref, got, tc.want)
		}
	}
	for c, motd := range map[string]string{c1: "hello from the web folder\n", c2: "two\n", c3: "other\n"} {
		b, err := fs.ReadFile(snapshot(t, repo, c, "").fsys, "services/web/motd.txt")
		if err != nil || string(b) != motd {
			t.Errorf("%s motd %q %v, want %q", c, b, err, motd)
		}
	}

	ctx := context.Background()
	for _, tc := range []struct {
		ref      Ref
		notFound bool
	}{
		{Ref{}, false},
		{Ref{Branch: "main", Commit: c3}, false},
		{Ref{Commit: c1[:12]}, false},
		{Ref{Commit: strings.ToUpper(c1)}, false},
		{Ref{Commit: strings.Repeat("0", 40)}, true},
		{Ref{Branch: "missing"}, true},
		{Ref{Tag: "missing"}, true},
		{Ref{Branch: "main", Commit: strings.Repeat("1", 40)}, false},
	} {
		_, err := repo.Fetch(ctx, tc.ref)
		if err == nil || errors.Is(err, ErrNotFound) != tc.notFound {
			t.Errorf("%+v: %v (not found %v)", tc.ref, err, tc.notFound)
		}
	}
	if _, err := repo.Snapshot(strings.Repeat("2", 40), ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("snapshot of a missing commit: %v", err)
	}
	if _, err := repo.Snapshot("HEAD", ""); err == nil {
		t.Error("snapshot of a name, not a commit")
	}
}

// TestGitShallowThenOlderCommit: a branch fetched one commit deep, then an
// older commit of it.
func TestGitShallowThenOlderCommit(t *testing.T) {
	r := newRemote(t)
	c1 := gitRun(t, r.work, "rev-parse", "HEAD")
	r.commit(t, "two", map[string]string{"services/web/motd.txt": "two\n"})
	c3 := r.commit(t, "three", map[string]string{"services/web/motd.txt": "three\n"})
	for _, branch := range []string{"main", ""} {
		repo := r.open(t, RepoOptions{Depth: 1})
		if got := fetch(t, repo, Ref{Branch: "main"}); got != c3 {
			t.Fatalf("tip %s, want %s", got, c3)
		}
		if _, err := repo.Snapshot(c1, ""); !errors.Is(err, ErrNotFound) {
			t.Fatalf("the old commit is there before fetching it: %v", err)
		}
		if got := fetch(t, repo, Ref{Branch: branch, Commit: c1}); got != c1 {
			t.Fatalf("branch %q: %s, want %s", branch, got, c1)
		}
		b, err := fs.ReadFile(snapshot(t, repo, c1, "").fsys, "services/web/motd.txt")
		if err != nil || string(b) != "hello from the web folder\n" {
			t.Fatalf("branch %q: motd %q %v", branch, b, err)
		}
	}
}

func TestGitSnapshotsOutliveFetches(t *testing.T) {
	r := newRemote(t)
	repo := r.open(t, RepoOptions{Depth: 1})
	c1 := fetch(t, repo, Ref{Branch: "main"})
	old := snapshot(t, repo, c1, "")
	if got := fetch(t, repo, Ref{Branch: "main"}); got != c1 {
		t.Fatalf("up to date: %s, want %s", got, c1)
	}
	c2 := r.commit(t, "two", map[string]string{"services/web/motd.txt": "two\n", "services/api/score.yaml": ""})
	if got := fetch(t, repo, Ref{Branch: "main"}); got != c2 {
		t.Fatalf("after a push: %s, want %s", got, c2)
	}
	ctx := context.Background()
	oldSvcs, _ := old.Services(ctx)
	newSvcs, _ := snapshot(t, repo, c2, "").Services(ctx)
	if !reflect.DeepEqual(oldSvcs, []string{"api", "web"}) || !reflect.DeepEqual(newSvcs, []string{"web"}) {
		t.Fatalf("old %q new %q", oldSvcs, newSvcs)
	}
	// Opened again from the same folder, the repository keeps what it has.
	again, err := OpenRepo(repo.dir, RepoOptions{URL: r.bare, AllowLocal: true})
	if err != nil {
		t.Fatal(err)
	}
	sameBundles(t, snapshot(t, again, c1, ""), old)
}

func TestGitFileLimit(t *testing.T) {
	r := newRemote(t)
	big := strings.Repeat("a: b\n", MaxFileSize/5+1)
	c := r.commit(t, "big", map[string]string{"services/web/patches/big.yaml": big})
	repo := r.open(t, RepoOptions{})
	fetch(t, repo, Ref{Branch: "main"})
	src := snapshot(t, repo, c, "")

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	st, err := fs.Stat(src.fsys, "services/web/patches/big.yaml")
	if err != nil || st.Size() != int64(len(big)) {
		t.Fatalf("stat: %v %v, want size %d", st, err, len(big))
	}
	f, err := src.fsys.Open("services/web/patches/big.yaml")
	if err != nil {
		t.Fatal(err)
	}
	_, readErr := f.Read(make([]byte, 10))
	runtime.ReadMemStats(&after)
	if readErr == nil || !strings.Contains(readErr.Error(), "limit") {
		t.Errorf("read of a file above the limit: %v", readErr)
	}
	if n := after.TotalAlloc - before.TotalAlloc; n > MaxFileSize/4 {
		t.Errorf("stat and open of a %d-byte file allocated %d bytes", len(big), n)
	}
	if _, err := src.Load(context.Background(), "web", "alpha"); err == nil || !strings.Contains(err.Error(), "limit") {
		t.Errorf("load: %v", err)
	}
}

func TestGitURLs(t *testing.T) {
	for _, tc := range []struct {
		url  string
		o    RepoOptions
		good bool
	}{
		{"https://github.com/o/r.git", RepoOptions{}, true},
		{"ssh://git@github.com/o/r.git", RepoOptions{}, true},
		{"git@github.com:o/r.git", RepoOptions{}, true},
		{"https://x-access-token:secret@github.com/o/r.git", RepoOptions{}, false},
		{"https://secret@github.com/o/r.git", RepoOptions{}, false},
		{"ssh://git:secret@github.com/o/r.git", RepoOptions{}, false},
		{"http://gitea.ci.svc/o/r.git", RepoOptions{}, false},
		{"http://gitea.ci.svc/o/r.git", RepoOptions{AllowHTTP: true}, true},
		{"/srv/mirror/r.git", RepoOptions{}, false},
		{"file:///srv/mirror/r.git", RepoOptions{}, false},
		{"/srv/mirror/r.git", RepoOptions{AllowLocal: true}, true},
		{"file:///srv/mirror/r.git", RepoOptions{AllowLocal: true}, true},
		{"ftp://example.com/r.git", RepoOptions{AllowHTTP: true, AllowLocal: true}, false},
		{"", RepoOptions{AllowLocal: true}, false},
	} {
		tc.o.URL = tc.url
		_, err := OpenRepo(t.TempDir(), tc.o)
		if (err == nil) != tc.good {
			t.Errorf("%q %+v: %v", tc.url, tc.o, err)
		}
		if err != nil && strings.Contains(err.Error(), "secret") {
			t.Errorf("%q: the error carries the credential: %v", tc.url, err)
		}
	}
	dir := t.TempDir()
	if _, err := OpenRepo(dir, RepoOptions{URL: "https://github.com/o/a.git"}); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenRepo(dir, RepoOptions{URL: "https://github.com/o/b.git"}); err == nil {
		t.Error("a folder that mirrors another URL was opened")
	}
}

func TestGitCancelledFetch(t *testing.T) {
	r := newRemote(t)
	repo := r.open(t, RepoOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := repo.Fetch(ctx, Ref{Branch: "main"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("fetch with a cancelled context: %v", err)
	}
	fetch(t, repo, Ref{Branch: "main"})
}

// TestGitConcurrent reads while fetching; run with -race.
func TestGitConcurrent(t *testing.T) {
	r := newRemote(t)
	repo := r.open(t, RepoOptions{})
	c := fetch(t, repo, Ref{Branch: "main"})
	src := snapshot(t, repo, c, "")
	want, err := src.Load(context.Background(), "web", "prod")
	if err != nil {
		t.Fatal(err)
	}
	pushes := make([]string, 3)
	for i := range pushes {
		pushes[i] = r.commit(t, "more", map[string]string{"services/web/motd.txt": strconv.Itoa(i) + "\n"})
	}
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for range pushes {
			if _, err := repo.Fetch(context.Background(), Ref{Branch: "main"}); err != nil {
				errs <- err
			}
		}
	}()
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 20 {
				b, err := src.Load(context.Background(), "web", "prod")
				if err == nil && !bytes.Equal(b.Score, want.Score) {
					err = errors.New("score changed")
				}
				if err == nil {
					_, err = fs.ReadFile(b.Files, "motd.txt")
				}
				if err != nil {
					errs <- err
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

// TestGitLoadAllocs caps what one Load from a snapshot allocates.
func TestGitLoadAllocs(t *testing.T) {
	r := newRemote(t)
	repo := r.open(t, RepoOptions{})
	src := snapshot(t, repo, fetch(t, repo, Ref{Branch: "main"}), "")
	ctx := context.Background()
	n := testing.AllocsPerRun(20, func() {
		if _, err := src.Load(ctx, "web", "prod"); err != nil {
			t.Fatal(err)
		}
	})
	t.Logf("Load from a git snapshot: %.0f allocations", n)
	if n > 1300 {
		t.Errorf("Load allocated %.0f times, above 1300", n)
	}
}
