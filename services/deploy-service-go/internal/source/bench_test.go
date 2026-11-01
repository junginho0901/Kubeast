package source

import (
	"context"
	"testing"
)

// BenchmarkGitLoad reads one workload in one environment from a snapshot:
// what a plan does per service once the commit is fetched.
func BenchmarkGitLoad(b *testing.B) {
	r := newRemote(b)
	repo := r.open(b, RepoOptions{})
	src := snapshot(b, repo, fetch(b, repo, Ref{Branch: "main"}), "")
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := src.Load(ctx, "web", "prod"); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkGitFetchNoChange is one poll of a branch that has not moved:
// the round trip to git-upload-pack (local, so no network time).
func BenchmarkGitFetchNoChange(b *testing.B) {
	r := newRemote(b)
	repo := r.open(b, RepoOptions{Depth: 1})
	fetch(b, repo, Ref{Branch: "main"})
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := repo.Fetch(ctx, Ref{Branch: "main"}); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkCommit makes a promotion's commit on top of a fetched base: one
// file set, its trees rebuilt and the commit written into the mirror (the
// push to the remote is git-receive-pack's time, measured end to end).
func BenchmarkCommit(b *testing.B) {
	r := newRemote(b)
	repo := r.open(b, RepoOptions{})
	base := fetch(b, repo, Ref{Branch: "main"})
	files := map[string][]byte{"environments/prod/web.score.yaml": []byte("containers:\n  app:\n    image: ghcr.io/example/web:2.0.1\n")}
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := repo.Commit(ctx, base, files, who, "deploy: promote web\n"); err != nil {
			b.Fatal(err)
		}
	}
}

// TestCommitAllocs caps one Commit, about a fifth above now: 631 on go1.26.0
// and 1.27.3 with go-git v5.19.3.
func TestCommitAllocs(t *testing.T) {
	r := newRemote(t)
	repo := r.open(t, RepoOptions{})
	base := fetch(t, repo, Ref{Branch: "main"})
	files := map[string][]byte{"environments/prod/web.score.yaml": []byte("containers:\n  app:\n    image: ghcr.io/example/web:2.0.1\n")}
	ctx := context.Background()
	n := testing.AllocsPerRun(20, func() {
		if _, err := repo.Commit(ctx, base, files, who, "deploy: promote web\n"); err != nil {
			t.Fatal(err)
		}
	})
	t.Logf("Commit: %.0f allocations", n)
	if n > 760 {
		t.Errorf("Commit allocated %.0f times, above 760", n)
	}
}
