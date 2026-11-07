package handler_test

import (
	"encoding/json"
	"strings"
	"testing"
)

// The Timeline's three routes, as the Timeline screen and a drawer call them.
var timelineRoutes = []string{
	"/api/v1/timeline",
	"/api/v1/namespaces/" + inside + "/timeline",
	"/api/v1/namespaces/" + inside + "/timeline/Pod/p",
}

// What the Timeline screen and the AI tool send, and the widest the API takes, read the cluster's events as they did.
func TestTimelineAnswersTheWindowsThatAreAskedFor(t *testing.T) {
	rig := newScopeRig(t, payloadFor(), nil)
	for _, route := range timelineRoutes {
		for _, query := range []string{"", "?hours=1&limit=500", "?hours=6&limit=500", "?hours=24&limit=500", "?hours=168&limit=500", "?hours=2160&limit=500", "?hours=24&limit=1", "?hours=24&limit=5000"} {
			w := rig.do("GET", route+query, "")
			if w.Code != 200 {
				t.Errorf("%s%s: %d %s", route, query, w.Code, w.Body)
				continue
			}
			var answer struct {
				Summary map[string]interface{} `json:"summary"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
				t.Fatalf("%s%s: %v", route, query, err)
			}
			if total, _ := answer.Summary["total_events"].(float64); total == 0 {
				t.Errorf("%s%s: no events read from a cluster that holds a recent one: %s", route, query, w.Body)
			}
		}
	}
}

// A window past 90 days, a time that overflows and a number that is none are refused with why: each of them read no
// events and answered as if there were none, or as if the default had been asked.
func TestTimelineRefusesAWindowItCannotRead(t *testing.T) {
	for _, c := range []struct{ query, word string }{
		{"?hours=2161", "hours"},
		{"?hours=3000000", "hours"},
		{"?hours=99999999999999999999", "hours"},
		{"?hours=0", "hours"},
		{"?hours=-1", "hours"},
		{"?hours=abc", "hours"},
		{"?limit=5001", "limit"},
		{"?limit=99999999999999999999", "limit"},
		{"?limit=0", "limit"},
		{"?limit=-1", "limit"},
		{"?limit=abc", "limit"},
	} {
		for _, route := range timelineRoutes {
			rig := newScopeRig(t, payloadFor(), nil)
			w := rig.do("GET", route+c.query, "")
			if w.Code != 400 {
				t.Errorf("%s%s: %d, want 400: %s", route, c.query, w.Code, w.Body)
				continue
			}
			if !strings.Contains(w.Body.String(), c.word) {
				t.Errorf("%s%s: the answer does not say what is wrong: %s", route, c.query, w.Body)
			}
			for _, call := range rig.api.callerCalls() {
				if strings.Contains(call.path, "/events") {
					t.Errorf("%s%s: the cluster was asked: %v", route, c.query, call)
				}
			}
		}
	}
}
