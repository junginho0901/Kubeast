package promote

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/source"
)

const prodFile = `# prod pins a digest; promotion replaces it
metadata:
  annotations:
    kubeast.io/autoscale: "4-20"   # quoted on purpose
containers:
  app:
    image: ghcr.io/example/web@sha256:3f6c0e0bdb3b2f9e1a6c6f5a9b0d4e8c7a1b2c3d4e5f60718293a4b5c6d7e8f9
    variables:
      MODE: prod
`

func TestImagesAndApply(t *testing.T) {
	got, err := Images([]byte("containers:\n  app:\n    image: ghcr.io/example/web:2.0.1\n  worker:\n    image: ghcr.io/example/worker@sha256:" + strings.Repeat("a", 64) + "\n  sidecar:\n    command: [x]\n"))
	if err != nil || !reflect.DeepEqual(got, map[string]string{"app": "ghcr.io/example/web:2.0.1", "worker": "ghcr.io/example/worker@sha256:" + strings.Repeat("a", 64)}) {
		t.Fatalf("images %v %v", got, err)
	}
	out, changed, err := Apply([]byte(prodFile), map[string]string{"app": "ghcr.io/example/web:2.0.1"})
	if err != nil || !reflect.DeepEqual(changed, []string{"app"}) {
		t.Fatalf("apply: %v %v", changed, err)
	}
	// Only the image line differs: comments, quoting and order stay.
	a, b := strings.Split(prodFile, "\n"), strings.Split(string(out), "\n")
	if len(a) != len(b) {
		t.Fatalf("line count %d → %d:\n%s", len(a), len(b), out)
	}
	diff := 0
	for i := range a {
		if a[i] != b[i] {
			diff++
			if b[i] != "    image: ghcr.io/example/web:2.0.1" {
				t.Errorf("line %d: %q → %q", i, a[i], b[i])
			}
		}
	}
	if diff != 1 {
		t.Errorf("%d lines changed, want 1:\n%s", diff, out)
	}
	// Already there: unchanged bytes, nothing changed.
	if again, changed, err := Apply(out, map[string]string{"app": "ghcr.io/example/web:2.0.1"}); err != nil || len(changed) != 0 || string(again) != string(out) {
		t.Errorf("second apply: %v %v", changed, err)
	}
	// A new file, and a file without the container.
	if out, changed, err := Apply(nil, map[string]string{"app": "ghcr.io/example/web:2.0.1"}); err != nil || string(out) != "containers:\n  app:\n    image: ghcr.io/example/web:2.0.1\n" || len(changed) != 1 {
		t.Errorf("new file %q %v %v", out, changed, err)
	}
	if out, _, err := Apply([]byte("metadata:\n    annotations: {a: b}\n"), map[string]string{"app": "x:1"}); err != nil || !strings.Contains(string(out), "containers:\n    app:\n        image: x:1") {
		t.Errorf("four-space file %q %v", out, err)
	}
	// In place, byte for byte: a comment after the image, both quotes, a
	// flow map with two images on one line.
	for in, want := range map[string]string{
		"containers:\n  app:\n    image: old:1    # pinned by release\n":       "containers:\n  app:\n    image: new:2    # pinned by release\n",
		"containers:\n  app:\n    image: \"old:1\" # q\n":                      "containers:\n  app:\n    image: \"new:2\" # q\n",
		"containers:\n  app:\n    image: 'old:1'\n":                            "containers:\n  app:\n    image: 'new:2'\n",
		"containers: {app: {image: old:1}, w: {image: old:1}}  # flow\n":       "containers: {app: {image: new:22}, w: {image: new:333}}  # flow\n",
		"# top\ncontainers:\n    app:\n        image:   old:1\n        x: 1\n": "# top\ncontainers:\n    app:\n        image:   new:2\n        x: 1\n",
		"containers:\r\n  app:\r\n    image: old:1\r\n":                        "containers:\r\n  app:\r\n    image: new:2\r\n",
	} {
		imgs := map[string]string{"app": "new:2"}
		if strings.Contains(in, "w:") { // other lengths, so a wrong edit order shows
			imgs = map[string]string{"app": "new:22", "w": "new:333"}
		}
		out, _, err := Apply([]byte(in), imgs)
		if err != nil || string(out) != want {
			t.Errorf("%q →\n %q, want\n %q (%v)", in, out, want, err)
		}
	}
	// A missing key: written back whole — the comment stays, its spacing evens.
	if out, changed, err := Apply([]byte("# keep me\ncontainers:\n  app:\n    variables: {A: b}   # vars\n"), map[string]string{"app": "new:2"}); err != nil || len(changed) != 1 ||
		!strings.Contains(string(out), "# keep me") || !strings.Contains(string(out), "# vars") || !strings.Contains(string(out), "image: new:2") {
		t.Errorf("missing image key: %q %v %v", out, changed, err)
	}
	if _, _, err := Apply([]byte("containers:\n  app:\n    image: |\n      old:1\n"), map[string]string{"app": "new:2"}); err == nil {
		t.Error("a block scalar image was edited")
	}
	for name, tc := range map[string]struct {
		file   string
		images map[string]string
	}{
		"no images":          {prodFile, nil},
		"bad image":          {prodFile, map[string]string{"app": "has space:1"}},
		"placeholder image":  {prodFile, map[string]string{"app": "."}},
		"containers a list":  {"containers: [a]\n", map[string]string{"app": "x:1"}},
		"container a string": {"containers:\n  app: x\n", map[string]string{"app": "x:1"}},
		"image a map":        {"containers:\n  app:\n    image: {a: b}\n", map[string]string{"app": "x:1"}},
		"not a map":          {"- a\n", map[string]string{"app": "x:1"}},
		"not YAML":           {"a: [", map[string]string{"app": "x:1"}},
	} {
		if _, _, err := Apply([]byte(tc.file), tc.images); err == nil {
			t.Errorf("%s: applied", name)
		}
	}
	for name, file := range map[string]string{"placeholder": "containers:\n  app:\n    image: .\n", "space": "containers:\n  app:\n    image: \"a b\"\n", "list": "containers: [a]\n"} {
		if _, err := Images([]byte(file)); err == nil {
			t.Errorf("images of %s: read", name)
		}
	}
}

// The remote is made by the real git, and what the push left is read back
// with it: contents, diff and git fsck.

func gitEnv(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Fatal("these tests need git on PATH")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	for k, v := range map[string]string{"GIT_AUTHOR_NAME": "a", "GIT_AUTHOR_EMAIL": "a@example.com", "GIT_COMMITTER_NAME": "c", "GIT_COMMITTER_EMAIL": "c@example.com"} {
		t.Setenv(k, v)
	}
}

func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

type remote struct{ work, bare string }

func newRemote(t *testing.T, files map[string]string) *remote {
	t.Helper()
	gitEnv(t)
	r := &remote{work: t.TempDir(), bare: t.TempDir()}
	gitRun(t, r.bare, "init", "--bare")
	gitRun(t, r.work, "init")
	gitRun(t, r.work, "remote", "add", "origin", r.bare)
	r.commit(t, "layout", files)
	return r
}

func (r *remote) commit(t *testing.T, msg string, files map[string]string) string {
	t.Helper()
	for name, data := range files {
		p := filepath.Join(r.work, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	gitRun(t, r.work, "add", "-A")
	gitRun(t, r.work, "commit", "-q", "-m", msg)
	gitRun(t, r.work, "push", "-q", "origin", "HEAD")
	return gitRun(t, r.work, "rev-parse", "HEAD")
}

var layout = map[string]string{
	"services/web/score.yaml":             "apiVersion: score.dev/v1b1\nmetadata:\n  name: web\ncontainers:\n  app:\n    image: .\n",
	"environments/alpha/_defaults.yaml":   "namespace: web-alpha\n",
	"environments/alpha/web.score.yaml":   "containers:\n  app:\n    image: ghcr.io/example/web:2.0.1\n",
	"environments/prod/_defaults.yaml":    "namespace: web-prod\n",
	"environments/prod/web.score.yaml":    prodFile,
	"environments/beta/_defaults.yaml":    "namespace: web-beta\n",
	"services/web/patches/keep.yaml":      "# untouched\n",
	"environments/alpha/other.score.yaml": "containers:\n  app:\n    image: ghcr.io/example/other:1\n",
}

func setup(t *testing.T) (*remote, *source.Repo, string) {
	t.Helper()
	r := newRemote(t, layout)
	repo, err := source.OpenRepo(t.TempDir(), source.RepoOptions{URL: r.bare, AllowLocal: true})
	if err != nil {
		t.Fatal(err)
	}
	base, err := repo.Fetch(context.Background(), source.Ref{Branch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	return r, repo, base
}

var who = source.Signature{Name: "Kubeast", Email: "kubeast@example.com", When: time.Date(2026, 11, 1, 21, 0, 0, 0, time.UTC)}

func TestPromoteCommitsAndPushes(t *testing.T) {
	r, repo, base := setup(t)
	res, err := Run(context.Background(), repo, Request{Service: "web", From: "alpha", To: "prod", Branch: "main", Base: base, Author: who})
	if err != nil {
		t.Fatal(err)
	}
	if res.Branch != "main" || res.Created || !reflect.DeepEqual(res.Changed, []string{"app"}) || res.Images["app"] != "ghcr.io/example/web:2.0.1" {
		t.Fatalf("result %+v", res)
	}
	if tip := gitRun(t, r.bare, "rev-parse", "main"); tip != res.Commit {
		t.Fatalf("remote main %s, want %s", tip, res.Commit)
	}
	if parent := gitRun(t, r.bare, "rev-parse", res.Commit+"^"); parent != base {
		t.Errorf("parent %s, want %s", parent, base)
	}
	if stat := gitRun(t, r.bare, "diff", "--numstat", base, res.Commit); stat != "1\t1\tenvironments/prod/web.score.yaml" {
		t.Errorf("diff %q", stat)
	}
	if got := gitRun(t, r.bare, "show", res.Commit+":environments/prod/web.score.yaml"); got != strings.TrimRight(strings.Replace(prodFile, "ghcr.io/example/web@sha256:3f6c0e0bdb3b2f9e1a6c6f5a9b0d4e8c7a1b2c3d4e5f60718293a4b5c6d7e8f9", "ghcr.io/example/web:2.0.1", 1), "\n") {
		t.Errorf("prod file now:\n%s", got)
	}
	if out := gitRun(t, r.bare, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", res.Commit); out != "Kubeast <kubeast@example.com>|Kubeast <kubeast@example.com>|deploy: promote web from alpha to prod" {
		t.Errorf("commit %q", out)
	}
	if out := gitRun(t, r.bare, "fsck", "--strict", "--no-dangling"); out != "" {
		t.Errorf("git fsck: %s", out)
	}
	// Promoting again changes nothing and makes no commit.
	again, err := Run(context.Background(), repo, Request{Service: "web", From: "alpha", To: "prod", Branch: "main", Base: res.Commit, Author: who})
	if err != nil || again.Commit != "" || len(again.Changed) != 0 {
		t.Fatalf("second promotion %+v %v", again, err)
	}
}

func TestPromoteCreatesTheFile(t *testing.T) {
	r, repo, base := setup(t)
	res, err := Run(context.Background(), repo, Request{Service: "web", From: "alpha", To: "beta", Branch: "main", Base: base, Author: who, Message: "promote web to beta\n"})
	if err != nil || !res.Created {
		t.Fatalf("%+v %v", res, err)
	}
	if got := gitRun(t, r.bare, "show", "main:environments/beta/web.score.yaml"); got != "containers:\n  app:\n    image: ghcr.io/example/web:2.0.1" {
		t.Errorf("beta file %q", got)
	}
	if stat := gitRun(t, r.bare, "diff", "--name-status", base, "main"); stat != "A\tenvironments/beta/web.score.yaml" {
		t.Errorf("diff %q", stat)
	}
	if out := gitRun(t, r.bare, "fsck", "--strict", "--no-dangling"); out != "" {
		t.Errorf("git fsck: %s", out)
	}
}

func TestPromoteNeverOverwrites(t *testing.T) {
	r, repo, base := setup(t)
	moved := r.commit(t, "someone else", map[string]string{"services/web/patches/keep.yaml": "# changed meanwhile\n"})
	_, err := Run(context.Background(), repo, Request{Service: "web", From: "alpha", To: "prod", Branch: "main", Base: base, Author: who})
	if !errors.Is(err, source.ErrConflict) {
		t.Fatalf("push over a moved branch: %v", err)
	}
	if tip := gitRun(t, r.bare, "rev-parse", "main"); tip != moved {
		t.Fatalf("remote main %s, want the other commit %s", tip, moved)
	}
	// Fetch again and redo: it goes through.
	base2, err := repo.Fetch(context.Background(), source.Ref{Branch: "main"})
	if err != nil || base2 != moved {
		t.Fatalf("refetch %s %v", base2, err)
	}
	if _, err := Run(context.Background(), repo, Request{Service: "web", From: "alpha", To: "prod", Branch: "main", Base: base2, Author: who}); err != nil {
		t.Fatalf("redo: %v", err)
	}
}

func TestPromoteForAPullRequest(t *testing.T) {
	r, repo, base := setup(t)
	res, err := Run(context.Background(), repo, Request{Service: "web", From: "alpha", To: "prod", Branch: "main", Base: base, Author: who, PullRequest: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Branch != "kubeast/promote/web-prod-"+res.Commit[:12] {
		t.Fatalf("branch %q", res.Branch)
	}
	if tip := gitRun(t, r.bare, "rev-parse", "main"); tip != base {
		t.Errorf("main moved to %s", tip)
	}
	if tip := gitRun(t, r.bare, "rev-parse", res.Branch); tip != res.Commit {
		t.Errorf("%s at %s, want %s", res.Branch, tip, res.Commit)
	}
}

func TestPromoteRefuses(t *testing.T) {
	r, repo, base := setup(t)
	ctx := context.Background()
	for name, req := range map[string]Request{
		"same env":        {Service: "web", From: "alpha", To: "alpha"},
		"bad service":     {Service: "Web", From: "alpha", To: "prod"},
		"path in env":     {Service: "web", From: "../alpha", To: "prod"},
		"no source file":  {Service: "api", From: "alpha", To: "prod"},
		"no author":       {Service: "web", From: "alpha", To: "prod", Author: source.Signature{Name: "x"}},
		"bad branch":      {Service: "web", From: "alpha", To: "prod", Branch: "a..b"},
		"unknown base":    {Service: "web", From: "alpha", To: "prod", Base: strings.Repeat("0", 40)},
		"no image in src": {Service: "web", From: "beta", To: "prod"},
	} {
		if req.Branch == "" {
			req.Branch = "main"
		}
		if req.Base == "" {
			req.Base = base
		}
		if req.Author.Name == "" {
			req.Author = who
		}
		if _, err := Run(ctx, repo, req); err == nil {
			t.Errorf("%s: promoted", name)
		}
	}
	if tip := gitRun(t, r.bare, "rev-parse", "main"); tip != base {
		t.Errorf("refusals moved main to %s", tip)
	}
	if _, err := Run(ctx, repo, Request{Service: "api", From: "alpha", To: "prod", Branch: "main", Base: base, Author: who}); !errors.Is(err, source.ErrNotFound) {
		t.Errorf("missing source file: %v", err)
	}
}
