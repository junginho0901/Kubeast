package promote

import (
	"testing"
)

var benchImage = map[string]string{"app": "ghcr.io/example/web@sha256:0000000000000000000000000000000000000000000000000000000000000001"}

// BenchmarkApply is a promotion's file edit when the key is there: read the
// file, find the image and replace it in the bytes.
func BenchmarkApply(b *testing.B) {
	file := []byte(prodFile)
	b.ReportAllocs()
	for b.Loop() {
		if _, changed, err := Apply(file, benchImage); err != nil || len(changed) != 1 {
			b.Fatal(changed, err)
		}
	}
}

// BenchmarkApplyNewFile is the first promotion to an environment: the file
// is written from nothing.
func BenchmarkApplyNewFile(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		if _, changed, err := Apply(nil, benchImage); err != nil || len(changed) != 1 {
			b.Fatal(changed, err)
		}
	}
}

// TestApplyAllocs caps one Apply, about a fifth above now: 116 in place and
// 35 for a new file, on go1.26.0 and 1.27.3.
func TestApplyAllocs(t *testing.T) {
	for _, c := range []struct {
		name string
		file []byte
		max  float64
	}{{"in place", []byte(prodFile), 140}, {"new file", nil, 42}} {
		n := testing.AllocsPerRun(50, func() { Apply(c.file, benchImage) })
		t.Logf("%s: %.0f allocations", c.name, n)
		if n > c.max {
			t.Errorf("%s: %.0f allocations, above %.0f", c.name, n, c.max)
		}
	}
}
