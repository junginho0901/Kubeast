package poll

import (
	"strings"
	"testing"
	"time"
)

// TestSettings: the installer's intervals and budget are used, and the
// budget still stretches the interval when there are many repositories.
func TestSettings(t *testing.T) {
	cases := []struct {
		name string
		in   Input
		want Plan
	}{
		{"own interval alone", Input{Repos: 10, Settings: Settings{Interval: 2 * time.Minute}},
			Plan{Interval: 2 * time.Minute, Limit: 5_000, RequestsPerHour: 600}},
		{"own interval with webhooks", Input{Repos: 10, Webhooks: true, Settings: Settings{IntervalWithWebhooks: 30 * time.Minute}},
			Plan{Interval: 30 * time.Minute, Limit: 5_000, RequestsPerHour: 40}},
		{"the alone interval does not change the webhook one", Input{Repos: 10, Webhooks: true, Settings: Settings{Interval: 5 * time.Minute}},
			Plan{Interval: 10 * time.Minute, Limit: 5_000, RequestsPerHour: 120}},
		{"a smaller budget stretches further", Input{Repos: 500, Users: 50, Settings: Settings{Budget: 0.2}},
			Plan{Interval: 1_440 * time.Second, Limit: 12_500, RequestsPerHour: 2_500, Stretched: true}},
		{"a larger budget polls sooner", Input{Repos: 500, Users: 50, Settings: Settings{Budget: 0.9}},
			Plan{Interval: 320 * time.Second, Limit: 12_500, RequestsPerHour: 11_250, Stretched: true}},
		{"off", Input{Repos: 500, Users: 50, Webhooks: true, Settings: Settings{Off: true}},
			Plan{Limit: 12_500, Off: true, Warning: OffWarning}},
	}
	for _, c := range cases {
		got, err := Make(c.in)
		if err != nil || got != c.want {
			t.Errorf("%s: %+v, %v\nwant %+v", c.name, got, err, c.want)
		}
	}
}

// TestBudgetIsHonoured: whatever budget is set within bounds, polling stays
// within that share of the limit.
func TestBudgetIsHonoured(t *testing.T) {
	for _, budget := range []float64{MinBudget, 0.3, DefaultBudget, MaxBudget} {
		for _, repos := range []int{1, 100, 1_000, 5_000} {
			p, err := Make(Input{Repos: repos, Users: 50, Settings: Settings{Budget: budget}})
			if err != nil {
				t.Fatal(err)
			}
			if float64(p.RequestsPerHour) > float64(p.Limit)*budget {
				t.Errorf("budget %g, %d repos: %d requests an hour of %d", budget, repos, p.RequestsPerHour, p.Limit)
			}
		}
	}
}

func TestSettingsRefused(t *testing.T) {
	cases := map[string]struct {
		s    Settings
		want string
	}{
		"interval too short":    {Settings{Interval: 10 * time.Second}, "interval 10s is outside 30s to 24h0m0s"},
		"webhook interval long": {Settings{IntervalWithWebhooks: 25 * time.Hour}, "intervalWithWebhooks 25h0m0s is outside"},
		"budget too small":      {Settings{Budget: 0.05}, "budget 0.05 is outside 0.1 to 0.9"},
		"budget too large":      {Settings{Budget: 1}, "budget 1 is outside 0.1 to 0.9"},
		"negative interval":     {Settings{Interval: -time.Minute}, "interval -1m0s is outside"},
		"refused even when off": {Settings{Off: true, Budget: 2}, "budget 2 is outside"},
	}
	for name, c := range cases {
		_, err := Make(Input{Repos: 10, Settings: c.s})
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", name, err, c.want)
		}
		if err2 := c.s.Validate(); err2 == nil || err2.Error() != err.Error() {
			t.Errorf("%s: Validate %v and Make %v differ", name, err2, err)
		}
	}
	if err := (Settings{Interval: MinInterval, IntervalWithWebhooks: MaxInterval, Budget: MinBudget}).Validate(); err != nil {
		t.Errorf("the bounds themselves are refused: %v", err)
	}
}
