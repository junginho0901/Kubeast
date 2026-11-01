package poll

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Settings are what an installer turns about polling (decision 37:
// polling stays on as the fallback for lost webhook deliveries, and the
// installer can change how much of it there is). The zero value is the
// default: on, every minute alone, every 10 minutes with webhooks, half of
// the installation's limit.
type Settings struct {
	// Off turns polling off. Not advised: GitHub does not redeliver a
	// failed webhook delivery by itself, so a commit whose delivery was
	// lost is then not built until the next push. Plan.Warning says so.
	Off bool `json:"off,omitempty"`
	// Interval is the interval without webhooks. Zero: IntervalAlone.
	Interval time.Duration `json:"interval,omitempty"`
	// IntervalWithWebhooks is the fallback interval when webhooks deliver.
	// Zero: IntervalWithWebhooks.
	IntervalWithWebhooks time.Duration `json:"intervalWithWebhooks,omitempty"`
	// Budget is the share of the installation's hourly limit polling may
	// use. Zero: DefaultBudget.
	Budget float64 `json:"budget,omitempty"`
}

// Bounds of the settings.
const (
	MinInterval = 30 * time.Second
	MaxInterval = 24 * time.Hour
	MinBudget   = 0.1
	MaxBudget   = 0.9
)

// OffWarning is shown on screen and logged while polling is off.
const OffWarning = "polling is off: a commit whose webhook delivery GitHub failed to send is not built until the next push"

// Validate checks the settings as written (zero means the default) and
// returns every problem.
func (s Settings) Validate() error {
	var errs []string
	for name, d := range map[string]time.Duration{"interval": s.Interval, "intervalWithWebhooks": s.IntervalWithWebhooks} {
		if d != 0 && (d < MinInterval || d > MaxInterval) {
			errs = append(errs, fmt.Sprintf("%s %s is outside %s to %s", name, d, MinInterval, MaxInterval))
		}
	}
	if s.Budget != 0 && (s.Budget < MinBudget || s.Budget > MaxBudget) {
		errs = append(errs, fmt.Sprintf("budget %g is outside %g to %g", s.Budget, MinBudget, MaxBudget))
	}
	if len(errs) == 0 {
		return nil
	}
	sort.Strings(errs)
	return errors.New("polling settings: " + strings.Join(errs, "; "))
}

// withDefaults fills the zero fields.
func (s Settings) withDefaults() Settings {
	if s.Interval == 0 {
		s.Interval = IntervalAlone
	}
	if s.IntervalWithWebhooks == 0 {
		s.IntervalWithWebhooks = IntervalWithWebhooks
	}
	if s.Budget == 0 {
		s.Budget = DefaultBudget
	}
	return s
}
