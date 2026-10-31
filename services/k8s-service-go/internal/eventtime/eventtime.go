// Package eventtime reads when an event was seen and how many times, as kubectl prints it, for the event lists, the
// drawers and the live event updates alike.
package eventtime

import (
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Seen is an event's first and last time and count by kubectl's printEvent (v1.37): an events.k8s.io writer (the
// scheduler among them) fills eventTime and series instead of the timestamps and count, and its event seen once
// counts 1.
func Seen(e *corev1.Event) (first, last time.Time, count int32) {
	first = e.FirstTimestamp.Time
	if first.IsZero() {
		first = e.EventTime.Time
	}
	last = e.LastTimestamp.Time
	if last.IsZero() {
		last = first
	}
	count = e.Count
	if e.Series != nil {
		if !e.Series.LastObservedTime.IsZero() {
			last = e.Series.LastObservedTime.Time
		}
		count = e.Series.Count
	} else if count == 0 {
		count = 1
	}
	return first, last, count
}

// Last is when an event was last seen, or when it was made if it names no time: what the lists sort and cut by.
func Last(e *corev1.Event) time.Time {
	if _, last, _ := Seen(e); !last.IsZero() {
		return last
	}
	return e.CreationTimestamp.Time
}

// ISO writes a time as the API does (RFC 3339, UTC), and an unset one as "".
func ISO(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
