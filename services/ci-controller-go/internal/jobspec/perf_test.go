package jobspec

import (
	"os"
	"testing"

	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/pipeline"
	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/runner"
)

// maxParseRenderAllocs caps the allocations of reading the full pipeline
// and rendering its Job, about a fifth above what it takes now (584), so a change
// that makes it much heavier fails here. Allocation counts do not depend on
// the machine's load; time is measured by the benchmark, when nothing else
// runs.
const maxParseRenderAllocs = 700

func fullInput(tb testing.TB) (data []byte, in Input) {
	tb.Helper()
	data, err := os.ReadFile("testdata/full.pipeline.yaml")
	if err != nil {
		tb.Fatal(err)
	}
	in = Input{
		Build: Build{
			ID: "b1", Repo: "example/web", RepoURL: "https://github.com/example/web.git",
			CommitSHA: "0123456789abcdef0123456789abcdef01234567", Ref: "refs/heads/main", Event: "push",
		},
		Namespace: "ci-builds",
		Profile:   runner.DefaultProfile(),
		Images:    runner.DefaultImages(),
		GitSecret: "ci-b1-git",
		Secrets:   map[string]string{"npm-token": "ci-b1-npm-token", "registry": "ci-b1-registry"},
	}
	return data, in
}

func parseRender(tb testing.TB, data []byte, in Input) {
	p, err := pipeline.Parse(data)
	if err != nil {
		tb.Fatal(err)
	}
	in.Pipeline = p
	if _, err := Render(in); err != nil {
		tb.Fatal(err)
	}
}

func TestParseRenderAllocs(t *testing.T) {
	data, in := fullInput(t)
	allocs := testing.AllocsPerRun(50, func() { parseRender(t, data, in) })
	t.Logf("parse + render: %.0f allocations (cap %d)", allocs, maxParseRenderAllocs)
	if allocs > maxParseRenderAllocs {
		t.Fatalf("parse + render took %.0f allocations, the cap is %d", allocs, maxParseRenderAllocs)
	}
}

func BenchmarkParseRender(b *testing.B) {
	data, in := fullInput(b)
	b.ReportAllocs()
	for b.Loop() {
		parseRender(b, data, in)
	}
}
