package auditsink

import (
	"context"
	"fmt"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// Sink sends one batch of events. An error leaves the batch to be sent again.
type Sink interface {
	Send(ctx context.Context, events []Event) error
}

// Filter picks the events a sink receives. Actions are patterns in the
// permission syntax ("k8s.*.delete", "admin.*", "*"); results are
// success/failure. Empty lists match everything.
type Filter struct {
	Actions []string `yaml:"actions"`
	Results []string `yaml:"results"`
}

func (f Filter) validate() error {
	for _, r := range f.Results {
		if r != "success" && r != "failure" {
			return fmt.Errorf("filter.results: %q is not success or failure", r)
		}
	}
	for _, a := range f.Actions {
		if strings.TrimSpace(a) == "" {
			return fmt.Errorf("filter.actions: empty pattern")
		}
	}
	return nil
}

func (f Filter) Match(e Event) bool {
	if len(f.Actions) > 0 && !auth.MatchAny(f.Actions, e.Action) {
		return false
	}
	if len(f.Results) > 0 {
		ok := false
		for _, r := range f.Results {
			if r == e.Result {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

func (f Filter) Apply(events []Event) []Event {
	if len(f.Actions) == 0 && len(f.Results) == 0 {
		return events
	}
	var out []Event
	for _, e := range events {
		if f.Match(e) {
			out = append(out, e)
		}
	}
	return out
}
