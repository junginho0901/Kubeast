package k8s

import (
	"slices"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// gatherBreakers reads the breaker metrics of m and s as a scrape would, failing on a label other than service and by.
func gatherBreakers(t *testing.T, m *breakerMetrics, s *Service) (opens map[string]float64, refusals, open float64) {
	t.Helper()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(m.collectors()...)
	reg.MustRegister(openBreakersGauge(s))
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	opens = map[string]float64{}
	for _, f := range families {
		for _, sample := range f.GetMetric() {
			labels := map[string]string{}
			var names []string
			for _, l := range sample.GetLabel() {
				labels[l.GetName()] = l.GetValue()
				names = append(names, l.GetName())
			}
			if labels["service"] != "k8s" {
				t.Errorf("%s service=%q, want k8s", f.GetName(), labels["service"])
			}
			switch f.GetName() {
			case "kubeast_k8s_cluster_breaker_opens_total":
				if !slices.Equal(names, []string{"by", "service"}) {
					t.Errorf("%s labelled %v", f.GetName(), names)
				}
				opens[labels["by"]] = sample.GetCounter().GetValue()
			case "kubeast_k8s_cluster_breaker_refusals_total":
				if !slices.Equal(names, []string{"service"}) {
					t.Errorf("%s labelled %v", f.GetName(), names)
				}
				refusals = sample.GetCounter().GetValue()
			case "kubeast_k8s_cluster_breakers_open":
				if !slices.Equal(names, []string{"service"}) {
					t.Errorf("%s labelled %v", f.GetName(), names)
				}
				open = sample.GetGauge().GetValue()
			default:
				t.Errorf("unexpected metric %s", f.GetName())
			}
		}
	}
	return opens, refusals, open
}

// A breaker is counted once when it opens, by what opened it, not again while it stays open; each request it refuses
// is one refusal, the trial it lets through none; the gauge is the clusters open now. No cluster label.
func TestTheBreakersCountTheirOpeningsRefusalsAndOpenClusters(t *testing.T) {
	const period = 30 * time.Second
	m := newBreakerMetrics()
	h := newClusterHealth(2, period)
	h.counts = m
	at := time.Unix(1_000_000, 0)
	h.now = func() time.Time { return at }
	s := &Service{health: h}

	opens, refusals, open := gatherBreakers(t, m, s)
	if opens[breakerOpenedByRequests] != 0 || opens[breakerOpenedByHealthCheck] != 0 || refusals != 0 || open != 0 {
		t.Fatalf("at start opens %v refusals %v open %v, want zeros (both by series present)", opens, refusals, open)
	}
	if len(opens) != 2 {
		t.Fatalf("opens series %v, want requests and health_check from the start", opens)
	}

	h.recordFailure("a")
	h.recordFailure("a") // threshold: opens
	h.recordFailure("a") // already open: not counted again
	h.setOpen("b", true)
	h.setOpen("b", true) // already open
	h.setOpen("a", true) // already open, now by the probe: not counted
	opens, _, open = gatherBreakers(t, m, s)
	if opens[breakerOpenedByRequests] != 1 || opens[breakerOpenedByHealthCheck] != 1 || open != 2 {
		t.Fatalf("opens %v open %v, want requests 1, health_check 1, 2 open", opens, open)
	}

	for range 3 {
		if ok, _ := h.admit("a"); ok {
			t.Fatal("an open breaker let a request go within its period")
		}
	}
	if ok, _ := h.admit("c"); !ok { // a cluster never seen: closed, no refusal
		t.Fatal("a closed cluster refused")
	}
	at = at.Add(period)
	if ok, trial := h.admit("a"); !ok || trial.IsZero() {
		t.Fatal("no trial after the period")
	}
	_, refusals, _ = gatherBreakers(t, m, s)
	if refusals != 3 {
		t.Fatalf("refusals %v, want 3 (the trial and the closed cluster are none)", refusals)
	}

	h.recordSuccess("a")
	h.setOpen("b", false)
	if _, _, open = gatherBreakers(t, m, s); open != 0 {
		t.Fatalf("open %v after both closed, want 0", open)
	}
	h.setOpen("b", true)
	if opens, _, _ = gatherBreakers(t, m, s); opens[breakerOpenedByHealthCheck] != 2 {
		t.Fatalf("opens %v, want a second health_check opening after it closed", opens)
	}
}

// With the breaker off (threshold 0) there are no open clusters and nothing panics.
func TestOpenBreakersWithTheBreakerOff(t *testing.T) {
	if n := (&Service{health: newClusterHealth(0, 0)}).OpenBreakers(); n != 0 {
		t.Fatalf("OpenBreakers = %d, want 0", n)
	}
	var s *Service
	if s.OpenBreakers() != 0 {
		t.Fatal("nil service")
	}
}
