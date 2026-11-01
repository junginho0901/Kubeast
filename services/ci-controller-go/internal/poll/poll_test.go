package poll

import (
	"fmt"
	"testing"
	"time"
)

func TestInstallationLimit(t *testing.T) {
	// GitHub's "Rate limits for the REST API", 2026-11-01.
	cases := []struct {
		repos, users int
		ec           bool
		want         int
	}{
		{10, 5, false, 5_000},
		{21, 0, false, 5_050},
		{100, 30, false, 5_000 + 80*50 + 10*50},
		{500, 50, false, 12_500},
		{3, 3, true, 15_000},
	}
	for _, c := range cases {
		if got := InstallationLimit(c.repos, c.users, c.ec); got != c.want {
			t.Errorf("InstallationLimit(%d, %d, %v) = %d, want %d", c.repos, c.users, c.ec, got, c.want)
		}
	}
}

// TestPassLine is the CI design's pass line: polling uses at most half of
// the installation's limit, with 500 repositories and beyond, with and
// without webhooks.
func TestPassLine(t *testing.T) {
	for _, repos := range []int{1, 20, 100, 500, 2_000} {
		for _, webhooks := range []bool{false, true} {
			p := Make(Input{Repos: repos, Users: 50, Webhooks: webhooks})
			if float64(p.RequestsPerHour) > float64(p.Limit)*DefaultBudget {
				t.Errorf("%d repos, webhooks %v: %d requests an hour of %d", repos, webhooks, p.RequestsPerHour, p.Limit)
			}
			floor := IntervalAlone
			if webhooks {
				floor = IntervalWithWebhooks
			}
			if p.Interval < floor {
				t.Errorf("%d repos, webhooks %v: interval %s below %s", repos, webhooks, p.Interval, floor)
			}
		}
	}
}

func TestMake(t *testing.T) {
	cases := []struct {
		name string
		in   Input
		want Plan
	}{
		{"a few repositories alone: every minute", Input{Repos: 10}, Plan{Interval: time.Minute, Limit: 5_000, RequestsPerHour: 1_200}},
		{"with webhooks: every 10 minutes", Input{Repos: 10, Webhooks: true}, Plan{Interval: 10 * time.Minute, Limit: 5_000, RequestsPerHour: 120}},
		{"500 repositories alone: stretched to the budget", Input{Repos: 500, Users: 50},
			Plan{Interval: 576 * time.Second, Limit: 12_500, RequestsPerHour: 6_250, Stretched: true}},
		{"the limit a response gave wins over the estimate", Input{Repos: 500, Users: 50, Limit: 5_000},
			Plan{Interval: 1_440 * time.Second, Limit: 5_000, RequestsPerHour: 2_500, Stretched: true}},
		{"x-poll-interval is a floor", Input{Repos: 1, PollInterval: 90 * time.Second}, Plan{Interval: 90 * time.Second, Limit: 5_000, RequestsPerHour: 80}},
		{"no repositories", Input{}, Plan{Interval: time.Minute, Limit: 5_000}},
	}
	for _, c := range cases {
		if got := Make(c.in); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestOffsetsSpreadRepositories(t *testing.T) {
	interval := 10 * time.Minute
	buckets := make([]int, 10)
	for i := 0; i < 500; i++ {
		off := Offset(fmt.Sprintf("org/repo-%d", i), interval)
		if off < 0 || off >= interval {
			t.Fatalf("offset %s outside the interval", off)
		}
		buckets[int(off/(interval/10))]++
	}
	for i, n := range buckets {
		if n < 25 || n > 75 {
			t.Errorf("tenth %d of the interval has %d of 500 repositories: %v", i, n, buckets)
		}
	}
}

func TestNext(t *testing.T) {
	interval := 10 * time.Minute
	now := time.Date(2026, 11, 1, 6, 3, 7, 0, time.UTC)
	for _, repo := range []string{"Codertocat/Hello-World", "junginho0901/Kubeast", "a/b"} {
		next := Next(repo, interval, now)
		if !next.After(now) || next.Sub(now) > interval {
			t.Errorf("%s: next %s not within one interval after %s", repo, next, now)
		}
		if got := next.Sub(next.Truncate(interval)); got != Offset(repo, interval) {
			t.Errorf("%s: next %s is not on the repository's offset", repo, next)
		}
		if again := Next(repo, interval, next); again.Sub(next) != interval {
			t.Errorf("%s: the poll after %s is %s", repo, next, again)
		}
	}
}

func TestWait(t *testing.T) {
	now := time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC)
	reset := now.Add(20 * time.Minute)
	if w := Wait(4_000, 5_000, reset, now); w != 0 {
		t.Errorf("plenty left: wait %s", w)
	}
	if w := Wait(500, 5_000, reset, now); w != 20*time.Minute {
		t.Errorf("at the reserve: wait %s, want until the reset", w)
	}
	if w := Wait(10, 5_000, now.Add(-time.Second), now); w != 0 {
		t.Errorf("reset passed: wait %s", w)
	}
	if w := Wait(0, 0, reset, now); w != 0 {
		t.Errorf("no limit known: wait %s", w)
	}
}
