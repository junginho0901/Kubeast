package ws

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// A live update writes an event's times and count as the events list does (k8s eventRow, both through eventtime):
// an update passed the raw fields on, so the scheduler's events (events.k8s.io: eventTime, no count) lost their time
// and count on the Events page the moment one came. The cases are TestEventTimes_AsKubectlPrintsThem's.
func TestEventInfo_TimesAndCountAsTheList(t *testing.T) {
	cases := []struct {
		obj         map[string]interface{}
		first, last string
		count       int32
	}{
		{map[string]interface{}{"reason": "Pulled", "firstTimestamp": "2026-10-31T12:00:00Z", "lastTimestamp": "2026-10-31T12:05:00Z", "count": int64(3)},
			"2026-10-31T12:00:00Z", "2026-10-31T12:05:00Z", 3},
		{map[string]interface{}{"reason": "Scheduled", "eventTime": "2026-10-31T12:01:00.000000Z"},
			"2026-10-31T12:01:00Z", "2026-10-31T12:01:00Z", 1},
		{map[string]interface{}{"reason": "BackOff", "eventTime": "2026-10-31T12:00:00.000000Z", "series": map[string]interface{}{"count": int64(9), "lastObservedTime": "2026-10-31T12:08:00.000000Z"}},
			"2026-10-31T12:00:00Z", "2026-10-31T12:08:00Z", 9},
	}
	for _, c := range cases {
		c.obj["metadata"] = map[string]interface{}{"name": "e", "namespace": "a"}
		info := objectToInfo("events", &unstructured.Unstructured{Object: c.obj})
		if info["first_timestamp"] != c.first || info["last_timestamp"] != c.last || info["count"] != c.count {
			t.Errorf("%s: %v %v %v, want %s %s %d", c.obj["reason"], info["first_timestamp"], info["last_timestamp"], info["count"], c.first, c.last, c.count)
		}
	}
}
