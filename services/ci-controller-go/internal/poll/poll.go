// Package poll plans how often the controller asks GitHub for new commits.
// Polling always runs, also with webhooks on, so a lost delivery or a
// receiver outage does not stop builds (the way Argo CD polls next to its
// webhook); webhooks only make the interval longer.
//
// GitHub's REST guidance: poll on a fixed schedule only as often as needed,
// honour x-poll-interval, avoid concurrent requests, and make conditional
// requests — a 304 Not Modified does not count against the primary rate
// limit. The plan here assumes the worst case, every request counted.
package poll

import (
	"hash/fnv"
	"math"
	"time"
)

// Defaults of a plan.
const (
	// IntervalAlone is the interval without webhooks.
	IntervalAlone = time.Minute
	// IntervalWithWebhooks is the fallback interval when webhooks deliver.
	IntervalWithWebhooks = 10 * time.Minute
	// DefaultBudget is the share of the installation's hourly limit polling
	// may use, the CI design's pass line (at most 50% with 500 repositories).
	DefaultBudget = 0.5
	// DefaultRequestsPerRepo is one poll of one repository: its branches
	// and its open pull requests.
	DefaultRequestsPerRepo = 2
)

// Input describes one GitHub App installation.
type Input struct {
	Repos int
	// Users is the organization's member count, which raises the limit.
	Users           int
	EnterpriseCloud bool
	// Limit is X-RateLimit-Limit once a response has given it; zero uses
	// InstallationLimit's estimate.
	Limit    int
	Webhooks bool
	// RequestsPerRepo per poll; zero: DefaultRequestsPerRepo.
	RequestsPerRepo int
	// Budget is the share of the limit polling may use; zero: DefaultBudget.
	Budget float64
	// PollInterval is the largest x-poll-interval GitHub sent, if any.
	PollInterval time.Duration
}

// Plan is the interval at which every repository of the installation is
// polled once.
type Plan struct {
	Interval        time.Duration
	Limit           int
	RequestsPerHour int
	// Stretched: the budget, not the default, set the interval.
	Stretched bool
}

// InstallationLimit is GitHub's primary rate limit of an app installation
// ("Rate limits for the REST API"): 15,000 an hour on a GitHub Enterprise
// Cloud organization; otherwise 5,000, plus 50 for each repository past 20
// and each user past 20, at most 12,500.
func InstallationLimit(repos, users int, enterpriseCloud bool) int {
	if enterpriseCloud {
		return 15_000
	}
	limit := 5_000 + 50*max(0, repos-20) + 50*max(0, users-20)
	return min(limit, 12_500)
}

// Make plans the interval: the default for the mode, stretched as far as
// the budget needs, and never below GitHub's x-poll-interval.
func Make(in Input) Plan {
	limit := in.Limit
	if limit <= 0 {
		limit = InstallationLimit(in.Repos, in.Users, in.EnterpriseCloud)
	}
	perRepo := in.RequestsPerRepo
	if perRepo <= 0 {
		perRepo = DefaultRequestsPerRepo
	}
	budget := in.Budget
	if budget <= 0 || budget > 1 {
		budget = DefaultBudget
	}
	interval := IntervalAlone
	if in.Webhooks {
		interval = IntervalWithWebhooks
	}
	p := Plan{Limit: limit}
	if in.PollInterval > interval {
		interval = in.PollInterval
	}
	if in.Repos > 0 {
		perPoll := float64(in.Repos * perRepo)
		allowedPerHour := float64(limit) * budget
		need := time.Duration(math.Ceil(perPoll*3600/allowedPerHour)) * time.Second
		if need > interval {
			interval, p.Stretched = need, true
		}
		p.RequestsPerHour = int(math.Ceil(perPoll * float64(time.Hour) / float64(interval)))
	}
	p.Interval = interval
	return p
}

// Offset spreads repositories over the interval by a hash of their name,
// so the polls of one installation do not all start at once.
func Offset(repo string, interval time.Duration) time.Duration {
	if interval <= 0 {
		return 0
	}
	h := fnv.New64a()
	h.Write([]byte(repo))
	return time.Duration(h.Sum64() % uint64(interval))
}

// Next is the first poll of repo after now: the instants offset + k ×
// interval, the same for every controller replica.
func Next(repo string, interval time.Duration, now time.Time) time.Time {
	off := Offset(repo, interval)
	base := now.Truncate(interval).Add(off)
	if !base.After(now) {
		base = base.Add(interval)
	}
	return base
}

// Reserve is the share of the limit kept for the controller's other
// requests (reading commits and pipeline files, check runs).
const Reserve = 0.1

// Wait reports how long polling pauses given a response's rate-limit
// headers: nothing while more than Reserve of the limit remains, else
// until the reset.
func Wait(remaining, limit int, reset, now time.Time) time.Duration {
	if limit <= 0 || float64(remaining) > float64(limit)*Reserve {
		return 0
	}
	if d := reset.Sub(now); d > 0 {
		return d
	}
	return 0
}
