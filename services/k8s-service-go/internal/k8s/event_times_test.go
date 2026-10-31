package k8s

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The drawers, the events API and the timeline write an event's times and count as kubectl prints them, under the
// names the screens read (first_timestamp, last_timestamp): the drawers wrote first_time and last_time, which no
// screen read, so every drawer's Last Seen was "-", and the scheduler's events (events.k8s.io, eventTime only) counted 0.
func TestEventTimes_AsKubectlPrintsThem(t *testing.T) {
	t0 := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	kubelet := corev1.Event{Reason: "Pulled", FirstTimestamp: metav1.NewTime(t0), LastTimestamp: metav1.NewTime(t0.Add(5 * time.Minute)), Count: 3}
	scheduler := corev1.Event{Reason: "Scheduled", EventTime: metav1.NewMicroTime(t0.Add(time.Minute))}
	series := corev1.Event{Reason: "BackOff", EventTime: metav1.NewMicroTime(t0), Series: &corev1.EventSeries{Count: 9, LastObservedTime: metav1.NewMicroTime(t0.Add(8 * time.Minute))}}
	want := []struct {
		e           corev1.Event
		first, last string
		count       int32
	}{
		{kubelet, "2026-10-31T12:00:00Z", "2026-10-31T12:05:00Z", 3},
		{scheduler, "2026-10-31T12:01:00Z", "2026-10-31T12:01:00Z", 1},
		{series, "2026-10-31T12:00:00Z", "2026-10-31T12:08:00Z", 9},
	}
	drawer := formatEventList([]corev1.Event{kubelet, scheduler, series})
	for i, w := range want {
		d := drawer[i]
		if d["first_timestamp"] != w.first || d["last_timestamp"] != w.last || d["count"] != w.count {
			t.Errorf("drawer %s: %v %v %v, want %s %s %d", w.e.Reason, d["first_timestamp"], d["last_timestamp"], d["count"], w.first, w.last, w.count)
		}
		if _, ok := d["last_time"]; ok {
			t.Errorf("drawer %s still writes last_time", w.e.Reason)
		}
		r := eventRow(&want[i].e)
		if r["first_timestamp"] != w.first || r["last_timestamp"] != w.last || r["count"] != w.count {
			t.Errorf("events API %s: %v %v %v, want %s %s %d", w.e.Reason, r["first_timestamp"], r["last_timestamp"], r["count"], w.first, w.last, w.count)
		}
	}

	// newest first by when each was last seen: the series (12:08), the kubelet's (12:05), the scheduler's (12:01)
	sorted := []corev1.Event{scheduler, kubelet, series}
	sortEventsByTime(sorted)
	if sorted[0].Reason != "BackOff" || sorted[1].Reason != "Pulled" || sorted[2].Reason != "Scheduled" {
		t.Errorf("sorted %s %s %s", sorted[0].Reason, sorted[1].Reason, sorted[2].Reason)
	}
}
