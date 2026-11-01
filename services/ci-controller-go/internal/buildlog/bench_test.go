package buildlog

import (
	"bytes"
	"context"
	"io"
	"path/filepath"
	"testing"
)

var mib = bytes.Repeat([]byte("a build log line of a usual length, 64 bytes, ending in a break\n"), 1<<14) // 1 MiB

// BenchmarkCut writes 1 MiB through a step's Cut in 32 KiB writes, inside
// the budget (passed on) and over it (kept in the tail ring).
func BenchmarkCut(b *testing.B) {
	for _, tc := range []struct {
		name string
		lim  Limit
	}{
		{"within", DefaultLimit()},
		{"over", Limit{MaxBytes: 4096, Tail: DefaultTail}},
	} {
		b.Run(tc.name, func(b *testing.B) {
			b.SetBytes(int64(len(mib)))
			b.ReportAllocs()
			for b.Loop() {
				c := NewBudget(tc.lim).Step(io.Discard)
				for p := mib; len(p) > 0; p = p[min(len(p), 32<<10):] {
					c.Write(p[:min(len(p), 32<<10)])
				}
				c.Close()
			}
		})
	}
}

// BenchmarkSaveFile stores a 1 MiB step on disk: cut, gzip, fsync, rename.
func BenchmarkSaveFile(b *testing.B) {
	f, err := NewFile(filepath.Join(b.TempDir(), "logs"))
	if err != nil {
		b.Fatal(err)
	}
	ctx := context.Background()
	b.SetBytes(int64(len(mib)))
	b.ReportAllocs()
	for b.Loop() {
		if _, err := Save(ctx, f, NewBudget(DefaultLimit()), "b-bench", "build", bytes.NewReader(mib)); err != nil {
			b.Fatal(err)
		}
	}
}
