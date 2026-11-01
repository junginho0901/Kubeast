package signals

import (
	"fmt"
	"testing"

	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/github"
)

// bigRepo is one repository as a poll sees it: 200 branches, the 20 tags
// Heads reads and 50 open pull requests. next moves one branch, adds a tag
// and pushes to one pull request.
func bigRepo() (prev *Seen, same, next github.RepoHeads) {
	branches, tags := map[string]string{}, map[string]string{}
	var prs []github.PullRequest
	for i := range 200 {
		branches[fmt.Sprintf("feature/b%03d", i)] = fmt.Sprintf("%040x", i)
	}
	for i := range 20 {
		tags[fmt.Sprintf("v1.%d.0", i)] = fmt.Sprintf("%040x", 1000+i)
	}
	for i := range 50 {
		prs = append(prs, github.PullRequest{Number: i + 1, HeadSHA: fmt.Sprintf("%040x", 2000+i), Base: "main"})
	}
	same = heads(branches, tags, prs...)
	_, prev = FromPoll(nil, same, 7)

	moved := map[string]string{}
	for k, v := range branches {
		moved[k] = v
	}
	moved["feature/b007"] = fmt.Sprintf("%040x", 9001)
	tagged := map[string]string{}
	for k, v := range tags {
		tagged[k] = v
	}
	tagged["v1.20.0"] = fmt.Sprintf("%040x", 9002)
	pushed := append([]github.PullRequest(nil), prs...)
	pushed[3].HeadSHA = fmt.Sprintf("%040x", 9003)
	return prev, same, heads(moved, tagged, pushed...)
}

// BenchmarkFromPoll turns one repository's poll with three changes into
// build events, as the poll loop does for every repository each round.
func BenchmarkFromPoll(b *testing.B) {
	prev, _, next := bigRepo()
	b.ReportAllocs()
	for b.Loop() {
		if ev, _ := FromPoll(prev, next, 7); len(ev) != 3 {
			b.Fatalf("%d events", len(ev))
		}
	}
}

// TestFromPollAllocs caps what one repository's poll allocates, about a
// fifth above now: 43 with the three changes and 24 with none, on go1.26.0
// and 1.27.3.
func TestFromPollAllocs(t *testing.T) {
	prev, same, next := bigRepo()
	for _, c := range []struct {
		name string
		now  github.RepoHeads
		max  float64
	}{{"three changes", next, 52}, {"no change", same, 30}} {
		n := testing.AllocsPerRun(50, func() { FromPoll(prev, c.now, 7) })
		t.Logf("%s: %.0f allocations", c.name, n)
		if n > c.max {
			t.Errorf("%s: %.0f allocations, above %.0f", c.name, n, c.max)
		}
	}
}

// BenchmarkFromPollNoChange is the usual round: nothing moved.
func BenchmarkFromPollNoChange(b *testing.B) {
	prev, same, _ := bigRepo()
	b.ReportAllocs()
	for b.Loop() {
		if ev, _ := FromPoll(prev, same, 7); len(ev) != 0 {
			b.Fatalf("%d events", len(ev))
		}
	}
}
