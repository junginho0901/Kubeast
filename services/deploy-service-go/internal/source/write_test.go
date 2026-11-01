package source

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var who = Signature{Name: "Kubeast", Email: "kubeast@example.com", When: time.Date(2026, 11, 1, 21, 0, 0, 0, time.UTC)}

func TestCommitWritesOnlyTheFiles(t *testing.T) {
	r := newRemote(t)
	r.commit(t, "exec", map[string]string{"bin/run.sh": "#!/bin/sh\n"})
	gitRun(t, r.work, "update-index", "--chmod=+x", "bin/run.sh")
	gitRun(t, r.work, "commit", "-q", "-m", "x bit")
	gitRun(t, r.work, "push", "-q", "origin", "HEAD")
	repo := r.open(t, RepoOptions{})
	base := fetch(t, repo, Ref{Branch: "main"})
	ctx := context.Background()
	c, err := repo.Commit(ctx, base, map[string][]byte{
		"environments/prod/web.score.yaml": []byte("containers:\n  app:\n    image: x:1\n"),
		"new/deep/file.txt":                []byte("new\n"),
		"new.txt":                          []byte("git sorts this before the folder new\n"),
		"bin/run.sh":                       []byte("#!/bin/sh\necho changed\n"),
	}, who, "write three files\n")
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Push(ctx, c, "main"); err != nil {
		t.Fatal(err)
	}
	if got := gitRun(t, r.bare, "diff", "--name-status", base, "main"); got != "M\tbin/run.sh\nM\tenvironments/prod/web.score.yaml\nA\tnew.txt\nA\tnew/deep/file.txt" {
		t.Errorf("diff %q", got)
	}
	if mode := gitRun(t, r.bare, "ls-tree", "main", "bin/run.sh"); !strings.HasPrefix(mode, "100755 ") {
		t.Errorf("the executable bit was lost: %s", mode)
	}
	if out := gitRun(t, r.bare, "fsck", "--strict", "--no-dangling"); out != "" {
		t.Errorf("git fsck: %s", out)
	}
	// The pushed commit reads back through a snapshot.
	b, err := snapshot(t, repo, c, "").File("new/deep/file.txt")
	if err != nil || string(b) != "new\n" {
		t.Errorf("read back %q %v", b, err)
	}
}

func TestCommitRefuses(t *testing.T) {
	r := newRemote(t)
	if err := os.Symlink("web", filepath.Join(r.work, "services", "alias")); err != nil {
		t.Fatal(err)
	}
	r.commit(t, "link", nil)
	repo := r.open(t, RepoOptions{})
	base := fetch(t, repo, Ref{Branch: "main"})
	ctx := context.Background()
	same, _ := os.ReadFile(filepath.Join(r.work, "services/web/score.yaml"))
	for name, tc := range map[string]struct {
		base    string
		files   map[string][]byte
		who     Signature
		message string
		want    string // in the error, when set
	}{
		"through a link":  {files: map[string][]byte{"services/alias/score.yaml": []byte("x")}, want: "alias is not a folder"},
		"over a folder":   {files: map[string][]byte{"services/web": []byte("x")}, want: "web is not a file"},
		"under a file":    {files: map[string][]byte{"services/web/score.yaml/x": []byte("x")}, want: "score.yaml is not a folder"},
		"dot dot":         {files: map[string][]byte{"../x": []byte("x")}},
		"absolute":        {files: map[string][]byte{"/x": []byte("x")}},
		"git folder":      {files: map[string][]byte{".git/config": []byte("x")}},
		"nothing":         {files: map[string][]byte{}},
		"no change":       {files: map[string][]byte{"services/web/score.yaml": same}},
		"no author email": {files: map[string][]byte{"a": []byte("x")}, who: Signature{Name: "x"}},
		"no message":      {files: map[string][]byte{"a": []byte("x")}, message: " "},
		"short base":      {base: base[:12], files: map[string][]byte{"a": []byte("x")}},
		"unknown base":    {base: strings.Repeat("0", 40), files: map[string][]byte{"a": []byte("x")}},
	} {
		if tc.base == "" {
			tc.base = base
		}
		if tc.who.Name == "" {
			tc.who = who
		}
		if tc.message == "" {
			tc.message = "m"
		}
		if _, err := repo.Commit(ctx, tc.base, tc.files, tc.who, tc.message); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v (want an error with %q)", name, err, tc.want)
		}
	}
	for _, b := range []string{"", "a..b", "a b", "-x", "x.lock", "refs/heads/x"} {
		if err := repo.Push(ctx, base, b); err == nil || errors.Is(err, ErrConflict) {
			t.Errorf("push to %q: %v", b, err)
		}
	}
}
