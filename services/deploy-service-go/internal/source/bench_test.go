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
