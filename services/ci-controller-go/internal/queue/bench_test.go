package queue

import (
	"fmt"
	"testing"
)

// BenchmarkSubmit adds one build to a queue already holding 10 running
// and 999 waiting builds, then removes it again so the size stays.
func BenchmarkSubmit(b *testing.B) {
	q, err := New(Settings{})
	if err != nil {
		b.Fatal(err)
	}
	for i := 0; i < DefaultMaxRunning+DefaultMaxWaiting-1; i++ {
		if _, err := q.Submit(build(i, fmt.Sprintf("org/r%d", i%50), fmt.Sprintf("refs/heads/b%05d", i), "1")); err != nil {
			b.Fatal(err)
		}
	}
	next := build(99_999, "org/r7", "refs/heads/new", "2")
	b.ReportAllocs()
	for b.Loop() {
		if _, err := q.Submit(next); err != nil {
			b.Fatal(err)
		}
		q.Remove(next.ID)
	}
}
