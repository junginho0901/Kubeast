package drains

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// gatherDrains reads tr's metrics as a scrape would, failing on a label other than service and status.
func gatherDrains(t *testing.T, tr *Tracker) (ended map[string]float64, running, holding float64) {
	t.Helper()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(Collectors(tr)...)
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	ended = map[string]float64{}
	for _, f := range families {
		for _, s := range f.GetMetric() {
			labels := map[string]string{}
			var names []string
			for _, l := range s.GetLabel() {
				labels[l.GetName()] = l.GetValue()
				names = append(names, l.GetName())
			}
			if labels["service"] != "k8s" {
				t.Errorf("%s service=%q, want k8s", f.GetName(), labels["service"])
			}
			switch f.GetName() {
			case "kubeast_k8s_node_drains_ended_total":
				if !slices.Equal(names, []string{"service", "status"}) {
					t.Errorf("%s labelled %v", f.GetName(), names)
				}
				ended[labels["status"]] = s.GetCounter().GetValue()
			case "kubeast_k8s_node_drains_running":
				running = s.GetGauge().GetValue()
			case "kubeast_k8s_node_drains_holding":
				holding = s.GetGauge().GetValue()
			default:
				t.Errorf("unexpected metric %s", f.GetName())
			}
			if f.GetName() != "kubeast_k8s_node_drains_ended_total" && !slices.Equal(names, []string{"service"}) {
				t.Errorf("%s labelled %v", f.GetName(), names)
			}
		}
	}
	return ended, running, holding
}

// A replica counts the drains it runs, whether they hold their evictions (a heartbeat holdAfter old), and each drain
// whose end it wrote by status: its own success and error, a gone server's drain it marked interrupted, its own drains
// at shutdown. No cluster, node or user label.
func TestTheDrainMetricsCountRunningHoldingAndEnds(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 20, 1, 0, 0, 0, time.UTC)}
	db := NewMemory(c.now)
	a, b := NewTracker(db, nil), NewTracker(db, nil)
	a.ends, b.ends = newEndCounts(), newEndCounts()
	onClock(c, a, b)

	ended, running, holding := gatherDrains(t, a)
	if len(ended) != 3 || ended[StatusSuccess]+ended[StatusError]+ended[StatusInterrupted] != 0 || running != 0 || holding != 0 {
		t.Fatalf("at start ended %v running %v holding %v, want the three statuses at 0", ended, running, holding)
	}

	begin(t, a, "d1", "n1")
	begin(t, a, "d2", "n2")
	begin(t, a, "d3", "n3")
	if _, running, holding = gatherDrains(t, a); running != 3 || holding != 0 {
		t.Fatalf("running %v holding %v, want 3 and 0", running, holding)
	}
	c.add(a.holdAfter)
	if _, _, holding = gatherDrains(t, a); holding != 1 {
		t.Fatalf("holding %v with no heartbeat saved for holdAfter, want 1", holding)
	}
	a.beat(context.Background())
	if _, _, holding = gatherDrains(t, a); holding != 0 {
		t.Fatalf("holding %v after a saved beat, want 0", holding)
	}

	a.Finish("d1", StatusSuccess, "drain completed")
	a.Finish("d2", StatusError, "drain incomplete")
	if ended, running, _ = gatherDrains(t, a); ended[StatusSuccess] != 1 || ended[StatusError] != 1 || running != 1 {
		t.Fatalf("ended %v running %v, want one success, one error, one running", ended, running)
	}

	// a stops beating: b, in contact, marks d3 interrupted and counts it; a counts nothing for it
	c.add(a.staleAfter + time.Second)
	inContact(b)
	if r := status(t, b, "d3"); r.Status != StatusInterrupted {
		t.Fatalf("d3 read %+v", r)
	}
	if ended, _, _ = gatherDrains(t, b); ended[StatusInterrupted] != 1 {
		t.Fatalf("b ended %v, want the interrupted drain it marked", ended)
	}
	if ended, _, _ = gatherDrains(t, a); ended[StatusInterrupted] != 0 {
		t.Fatalf("a ended %v, want no interrupted end of its own", ended)
	}

	// b's own drain at its shutdown
	begin(t, b, "d4", "n4")
	b.Shutdown(context.Background())
	if ended, running, _ = gatherDrains(t, b); ended[StatusInterrupted] != 2 || running != 0 {
		t.Fatalf("b ended %v running %v after shutdown, want 2 interrupted and none running", ended, running)
	}
}
