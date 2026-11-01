package gate

import (
	"context"
	"testing"
)

// Pass line of the gate (design ⓑ §10): one check (one workload's objects)
// at most 10 ms, a thousand at most 5 s, no network. CI holds the allocation
// count; the times go in the pull request.
const maxCheckAllocs = 11000

func BenchmarkCheck(b *testing.B) {
	objs := objects(webAlpha(b).res)
	g := newGate(b, Config{})
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		if _, err := g.Check(ctx, Input{Objects: objs}); err != nil {
			b.Fatal(err)
		}
	}
}

func TestCheckAllocations(t *testing.T) {
	objs := objects(webAlpha(t).res)
	g := newGate(t, Config{})
	ctx := context.Background()
	n := testing.AllocsPerRun(50, func() {
		if _, err := g.Check(ctx, Input{Objects: objs}); err != nil {
			t.Fatal(err)
		}
	})
	t.Logf("check allocations: %.0f (ceiling %d)", n, maxCheckAllocs)
	if n > maxCheckAllocs {
		t.Fatalf("a check allocates %.0f times, above the ceiling %d", n, maxCheckAllocs)
	}
}
