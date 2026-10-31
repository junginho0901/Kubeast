package render

import (
	"os"
	"testing"

	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/spec"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/target"
)

// Pass lines of the deploy module (design ⓑ §10): one render (one Score file
// to its objects) at most 1 ms, a thousand at most 1 s. Time varies by
// machine, so CI holds the allocation count, which does not; the benchmark
// numbers go in the pull request.
const maxRenderAllocs = 900

func webInput(tb testing.TB) Input {
	tb.Helper()
	score, err := os.ReadFile("testdata/web.score.yaml")
	if err != nil {
		tb.Fatal(err)
	}
	envData, err := os.ReadFile("testdata/env-alpha.yaml")
	if err != nil {
		tb.Fatal(err)
	}
	env, err := target.Parse(envData)
	if err != nil {
		tb.Fatal(err)
	}
	s, err := spec.Load(spec.Input{Score: score, Files: os.DirFS("testdata/files")})
	if err != nil {
		tb.Fatal(err)
	}
	return Input{Spec: s, Env: env, Peers: peers}
}

func TestRenderAllocations(t *testing.T) {
	in := webInput(t)
	n := testing.AllocsPerRun(200, func() {
		if _, err := Render(in); err != nil {
			t.Fatal(err)
		}
	})
	t.Logf("render allocations: %.0f (ceiling %d)", n, maxRenderAllocs)
	if n > maxRenderAllocs {
		t.Fatalf("render allocates %.0f times, above the ceiling %d", n, maxRenderAllocs)
	}
}

func BenchmarkRender(b *testing.B) {
	in := webInput(b)
	b.ReportAllocs()
	for b.Loop() {
		if _, err := Render(in); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkRenderYAML(b *testing.B) {
	in := webInput(b)
	b.ReportAllocs()
	for b.Loop() {
		res, err := Render(in)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := res.YAML(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLoad(b *testing.B) {
	score, err := os.ReadFile("testdata/web.score.yaml")
	if err != nil {
		b.Fatal(err)
	}
	files := os.DirFS("testdata/files")
	if _, err := spec.Load(spec.Input{Score: score, Files: files}); err != nil {
		b.Fatal(err) // also compiles the schema once, outside the loop
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := spec.Load(spec.Input{Score: score, Files: files}); err != nil {
			b.Fatal(err)
		}
	}
}
