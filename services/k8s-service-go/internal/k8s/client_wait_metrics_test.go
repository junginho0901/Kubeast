package k8s

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

type waitSeries struct {
	count uint64
	sum   float64
}

// gatherWaits reads m as a scrape would: the histogram by "<limiter>/<passed_over>" and the counter by limiter, failing on any other label.
func gatherWaits(t *testing.T, m *clientWaitMetrics) (map[string]waitSeries, map[string]float64) {
	t.Helper()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(m.collectors()...)
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	seconds, waited := map[string]waitSeries{}, map[string]float64{}
	for _, f := range families {
		for _, s := range f.GetMetric() {
			labels := map[string]string{}
			var names []string
			for _, l := range s.GetLabel() {
				labels[l.GetName()] = l.GetValue()
				names = append(names, l.GetName())
			}
			switch f.GetName() {
			case "kubeast_k8s_client_rate_wait_seconds":
				if !slices.Equal(names, []string{"limiter", "passed_over", "service"}) {
					t.Errorf("%s labelled %v", f.GetName(), names)
				}
				seconds[labels["limiter"]+"/"+labels["passed_over"]] = waitSeries{s.GetHistogram().GetSampleCount(), s.GetHistogram().GetSampleSum()}
			case "kubeast_k8s_client_rate_waits_total":
				if !slices.Equal(names, []string{"limiter", "service"}) {
					t.Errorf("%s labelled %v", f.GetName(), names)
				}
				waited[labels["limiter"]] = s.GetCounter().GetValue()
			default:
				t.Errorf("unexpected metric %s", f.GetName())
			}
			if labels["service"] != "k8s" {
				t.Errorf("%s service=%q, want k8s", f.GetName(), labels["service"])
			}
		}
	}
	return seconds, waited
}

// Every request on the client's rate is one observation, a request that went at once 0 and one that left while waiting the time it waited, under the limiter and passed_over only.
func TestEachRequestOnTheClientsRateIsTimedByLimiterAndPassedOverOnly(t *testing.T) {
	m := newClientWaitMetrics()
	l := newTurnLimiter(10, 1, m.forLimiter(limiterUser))
	m.forLimiter(limiterReview)
	const calls = 4
	for i := 0; i < calls; i++ {
		if err := l.Wait(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := l.Wait(ctx); err == nil {
		t.Fatal("a request whose context ended before the next token got one")
	}
	seconds, waited := gatherWaits(t, m)
	keys := make([]string, 0, len(seconds))
	for k := range seconds {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	if want := []string{"review/false", "review/true", "user/false", "user/true"}; !slices.Equal(keys, want) {
		t.Fatalf("series %v, want %v", keys, want)
	}
	got := seconds["user/false"]
	t.Logf("%d requests waited %.3f s in all, %v of them waited", got.count, got.sum, waited["user"])
	if got.count != calls+1 || got.sum <= 0 {
		t.Errorf("user/false: %d observations summing %v s, want %d summing above 0", got.count, got.sum, calls+1)
	}
	// the first went at once; at 10 a second and a burst of 1 the next three and the one that left waited
	if waited["user"] != calls {
		t.Errorf("%v requests counted as waiting, want %d", waited["user"], calls)
	}
	if seconds["user/true"].count != 0 || seconds["review/false"].count != 0 || waited["review"] != 0 {
		t.Errorf("observations under another label: %v %v", seconds, waited)
	}
}

// A check asked again is counted as passed over when a request that came after it took a token before it, at the bound or before; behind an earlier request it is not.
func TestACheckAskedAgainIsPassedOverWhenALaterRequestWentFirst(t *testing.T) {
	withPassOverLimit(t, 10*time.Second)
	crowd := []turnRequest{{at: 0, person: -1}, {at: time.Millisecond, again: true, person: 1}}
	for at := 2 * time.Millisecond; at < 12*time.Second; at += 5 * time.Millisecond {
		crowd = append(crowd, turnRequest{at: at, person: -1})
	}
	for _, c := range []struct {
		name             string
		reqs             []turnRequest
		passedOver       uint64
		minWait, maxWait time.Duration
		inTurn, waited   int
	}{
		{"behind an earlier request", []turnRequest{{at: 0, person: -1}, {at: time.Millisecond, person: 2}, {at: 2 * time.Millisecond, again: true, person: 1}}, 0, 0, 0, 3, 2},
		{"one later request first", []turnRequest{{at: 0, person: -1}, {at: time.Millisecond, again: true, person: 1}, {at: 2 * time.Millisecond, person: 2}}, 1, 19 * time.Millisecond, 19 * time.Millisecond, 2, 2},
		{"later requests until the bound", crowd, 1, passOverLimit, passOverLimit + 20*time.Millisecond, len(crowd) - 1, len(crowd) - 1},
	} {
		m := newClientWaitMetrics()
		grants := runTurns(newTurnLimiter(100, 1, m.forLimiter(limiterUser)), time.Unix(0, 0), c.reqs, 0)
		if len(grants) != len(c.reqs) {
			t.Fatalf("%s: %d tokens for %d requests", c.name, len(grants), len(c.reqs))
		}
		seconds, waited := gatherWaits(t, m)
		over := seconds["user/true"]
		if over.count != c.passedOver {
			t.Errorf("%s: %d passed over, want %d", c.name, over.count, c.passedOver)
		}
		if lo, hi := c.minWait.Seconds(), c.maxWait.Seconds(); over.sum < lo-1e-9 || over.sum > hi+1e-9 {
			t.Errorf("%s: passed over for %v s, want %v to %v", c.name, over.sum, lo, hi)
		}
		if got := seconds["user/false"].count; got != uint64(c.inTurn) {
			t.Errorf("%s: %d in turn, want %d", c.name, got, c.inTurn)
		}
		if waited["user"] != float64(c.waited) {
			t.Errorf("%s: %v counted as waiting, want %d", c.name, waited["user"], c.waited)
		}
	}
}
