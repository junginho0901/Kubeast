package eventtime

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Each case is an event as a writer of one API leaves it, and what kubectl get events prints of it (printEvent):
// FIRST SEEN, LAST SEEN and COUNT.
func TestSeen_AsKubectlPrintsIt(t *testing.T) {
	t0 := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	cases := []struct {
		name              string
		e                 corev1.Event
		first, last, made time.Time
		count             int32
	}{
		{"core/v1 writer (kubelet)", corev1.Event{FirstTimestamp: metav1.NewTime(at(0)), LastTimestamp: metav1.NewTime(at(5)), Count: 4}, at(0), at(5), at(5), 4},
		{"events.k8s.io writer, seen once (scheduler)", corev1.Event{EventTime: metav1.NewMicroTime(at(1))}, at(1), at(1), at(1), 1},
		{"events.k8s.io writer, a series", corev1.Event{EventTime: metav1.NewMicroTime(at(1)), Series: &corev1.EventSeries{Count: 7, LastObservedTime: metav1.NewMicroTime(at(9))}}, at(1), at(9), at(9), 7},
		{"only the first time", corev1.Event{FirstTimestamp: metav1.NewTime(at(2)), Count: 1}, at(2), at(2), at(2), 1},
		{"no time at all", corev1.Event{ObjectMeta: metav1.ObjectMeta{CreationTimestamp: metav1.NewTime(at(3))}}, time.Time{}, time.Time{}, at(3), 1},
	}
	for _, c := range cases {
		first, last, count := Seen(&c.e)
		if !first.Equal(c.first) || !last.Equal(c.last) || count != c.count {
			t.Errorf("%s: first %v last %v count %d, want %v %v %d", c.name, first, last, count, c.first, c.last, c.count)
		}
		if got := Last(&c.e); !got.Equal(c.made) {
			t.Errorf("%s: Last %v, want %v", c.name, got, c.made)
		}
	}
	if ISO(time.Time{}) != "" || ISO(at(0).In(time.FixedZone("KST", 9*3600))) != "2026-10-31T12:00:00Z" {
		t.Errorf("ISO")
	}
}
