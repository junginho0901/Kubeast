package main

import (
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

type timelineRow = map[string]interface{}

func timelineEvent(kind, name, eventType string, at time.Time) timelineRow {
	object := func() map[string]interface{} {
		return map[string]interface{}{"kind": kind, "name": name, "namespace": "shop", "api_version": "v1"}
	}
	return timelineRow{
		"timestamp": at.UTC().Format(time.RFC3339), "type": eventType, "reason": "Seen", "message": "seen " + name, "source": "kubelet",
		"resource": object(), "involved_object": object(), "count": 1, "first_seen": at.UTC().Format(time.RFC3339), "last_seen": at.UTC().Format(time.RFC3339),
	}
}

func timelineRollout(kind, name string, revision int, at time.Time) timelineRow {
	return timelineRow{"kind": kind, "name": name, "namespace": "shop", "revision": revision, "change_cause": nil, "created_at": at.UTC().Format(time.RFC3339), "images": []string{"web:1"}, "replicas": 1}
}

func timelineSummary(total, shown, matching, warning int) map[string]interface{} {
	return map[string]interface{}{
		"total_events": total, "events_shown": shown, "events_matching": matching, "normal_count": total - warning, "warning_count": warning,
		"time_range": map[string]interface{}{"start": "2026-11-06T00:00:00Z", "end": "2026-11-07T00:00:00Z"},
	}
}

func timelineReply(t *testing.T, events, rollouts []timelineRow, summary map[string]interface{}) string {
	t.Helper()
	out, err := marshalJSON(map[string]interface{}{"events": events, "rollout_history": rollouts, "summary": summary})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func rowNames(t *testing.T, rows interface{}) []string {
	t.Helper()
	list, ok := rows.([]interface{})
	if !ok {
		t.Fatalf("rows are not a list: %#v", rows)
	}
	names := []string{}
	for _, r := range list {
		m := r.(map[string]interface{})
		if object, ok := m["involved_object"].(map[string]interface{}); ok {
			names = append(names, fmt.Sprint(object["name"]))
			continue
		}
		names = append(names, fmt.Sprint(m["name"]))
	}
	return names
}

func subMap(t *testing.T, m map[string]interface{}, key string) map[string]interface{} {
	t.Helper()
	v, ok := m[key].(map[string]interface{})
	if !ok {
		t.Fatalf("%s = %#v, want an object", key, m[key])
	}
	return v
}

func subList(t *testing.T, m map[string]interface{}, key string) []interface{} {
	t.Helper()
	v, ok := m[key].([]interface{})
	if !ok {
		t.Fatalf("%s = %#v, want a list", key, m[key])
	}
	return v
}

func wantNull(t *testing.T, m map[string]interface{}, key string) {
	t.Helper()
	v, present := m[key]
	if !present {
		t.Fatalf("%s is left out, want null (not counted): %v", key, m)
	}
	if v != nil {
		t.Fatalf("%s = %#v, want null (not counted)", key, v)
	}
}

func TestTimeline_AsksTheScreensAPIAndKeepsItsCounts(t *testing.T) {
	now := time.Now()
	summary := timelineSummary(7, 2, 3, 3)
	reply := timelineReply(t, []timelineRow{timelineEvent("Pod", "a", "Warning", now), timelineEvent("Pod", "b", "Warning", now.Add(-time.Minute))},
		[]timelineRow{timelineRollout("Deployment", "web", 3, now)}, summary)
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, reply })
	out, err := handleTimeline(ctxFor("c1"), args{"namespace": "shop", "since_time": "6h", "limit": 500, "event_type": "Warning"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	if r.URL.Path != "/api/v1/namespaces/shop/timeline" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
	}
	q := r.URL.Query()
	if q.Get("cluster") != "c1" || q.Get("hours") != "6" || q.Get("limit") != "500" || q.Get("type") != "Warning" {
		t.Fatalf("query: %s", r.URL.RawQuery)
	}
	m := decode(t, out)
	if want := decode(t, reply)["summary"]; !reflect.DeepEqual(m["summary"], want) {
		t.Fatalf("summary = %v, want the API's %v", m["summary"], want)
	}
	if got := rowNames(t, m["events"]); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("events = %v", got)
	}
	if got := rowNames(t, m["rollout_history"]); !reflect.DeepEqual(got, []string{"web"}) {
		t.Fatalf("rollouts = %v", got)
	}
	if m["rollouts_total"] != float64(1) || m["namespace"] != "shop" || m["event_type"] != "Warning" {
		t.Fatalf("answer: %v", m)
	}
	first := subList(t, m, "events")[0].(map[string]interface{})
	if _, twice := first["resource"]; twice {
		t.Fatalf("an event's object is written twice: %v", first)
	}
	object := subMap(t, first, "involved_object")
	if object["kind"] != "Pod" || object["api_version"] != "v1" || first["count"] != float64(1) || first["reason"] != "Seen" {
		t.Fatalf("event row: %v", first)
	}
}

func TestTimeline_WithNoNamespaceAsksEveryNamespaceForTheScreensDay(t *testing.T) {
	seen := fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, timelineReply(t, []timelineRow{}, []timelineRow{}, timelineSummary(0, 0, 0, 0))
	})
	out, err := handleTimeline(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	q := r.URL.Query()
	if r.URL.Path != "/api/v1/timeline" || q.Get("hours") != "24" || q.Get("limit") != "200" || q.Has("type") {
		t.Fatalf("request: %s %s", r.URL.Path, r.URL.RawQuery)
	}
	if m := decode(t, out); m["namespace"] != "all namespaces" {
		t.Fatalf("namespace = %v", m["namespace"])
	}
}

func TestTimeline_AGrantLimitedToNamespacesStaysInIt(t *testing.T) {
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"shop", "web"}}}
	if err := namespaceGate(scoped, "c", "timeline", args{}); err != nil {
		t.Fatalf("no namespace named: k8s-service reads the grant's namespaces: %v", err)
	}
	if err := namespaceGate(scoped, "c", "timeline", args{"namespace": "web"}); err != nil {
		t.Fatalf("an own namespace: %v", err)
	}
	if err := namespaceGate(scoped, "c", "timeline", args{"namespace": "db"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("another namespace: %v", err)
	}
	seen := fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, timelineReply(t, []timelineRow{}, []timelineRow{}, timelineSummary(0, 0, 0, 0))
	})
	out, err := handleTimeline(ctxFor("c", "shop", "web"), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Path != "/api/v1/timeline" {
		t.Fatalf("path %s", (*seen)[0].URL.Path)
	}
	if got := decode(t, out)["namespace"]; !reflect.DeepEqual(got, []interface{}{"shop", "web"}) {
		t.Fatalf("namespace = %v, want the grant's", got)
	}
}

func TestTimeline_SaysTheListHoldsTheNewestOfAll(t *testing.T) {
	now := time.Now()
	rows := []timelineRow{timelineEvent("Pod", "a", "Normal", now), timelineEvent("Pod", "b", "Normal", now)}
	for _, c := range []struct {
		name      string
		summary   map[string]interface{}
		a         args
		wantNote  string
		wantNoCut bool
	}{
		{"cut", timelineSummary(7, 2, 7, 0), args{}, "newest 2 of the 7 events", false},
		{"cut of a type", timelineSummary(9, 2, 7, 7), args{"event_type": "Warning"}, "newest 2 of the 7 Warning events", false},
		{"whole", timelineSummary(2, 2, 2, 0), args{}, "", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			fakeK8sService(t, func(*http.Request) (int, string) { return 200, timelineReply(t, rows, []timelineRow{}, c.summary) })
			out, err := handleTimeline(ctxFor("c1"), c.a, bearer())
			if err != nil {
				t.Fatal(err)
			}
			note, has := decode(t, out)["events_note"].(string)
			if c.wantNoCut {
				if has {
					t.Fatalf("a whole list says %q", note)
				}
				return
			}
			if !strings.Contains(note, c.wantNote) {
				t.Fatalf("note = %q, want %q", note, c.wantNote)
			}
		})
	}
}

func TestTimeline_RolloutsThatCouldNotBeReadAreNotNone(t *testing.T) {
	summary := timelineSummary(0, 0, 0, 0)
	summary["rollouts_error"] = "list deployments for timeline: forbidden"
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, timelineReply(t, []timelineRow{}, []timelineRow{}, summary)
	})
	out, err := handleTimeline(ctxFor("c1"), args{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	wantNull(t, m, "rollouts_total")
	wantNull(t, m, "rollout_history")
	if subMap(t, m, "summary")["rollouts_error"] != "list deployments for timeline: forbidden" {
		t.Fatalf("summary: %v", m["summary"])
	}
	if note, _ := m["rollouts_note"].(string); !strings.Contains(note, "not counted") || !strings.Contains(note, "forbidden") {
		t.Fatalf("rollouts_note = %q", note)
	}
	if hint, has := m["hint"]; has {
		t.Fatalf("what was not read is not an empty window: %v", hint)
	}

	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, timelineReply(t, []timelineRow{}, []timelineRow{}, timelineSummary(0, 0, 0, 0))
	})
	out, err = handleTimeline(ctxFor("c1"), args{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	if m["rollouts_total"] != float64(0) {
		t.Fatalf("rollouts read and none found is 0, got %#v", m["rollouts_total"])
	}
	if _, has := m["rollouts_note"]; has {
		t.Fatalf("no reason to give: %v", m)
	}
}

func TestTimeline_TheWindowIsWholeHoursBackFromNow(t *testing.T) {
	now := time.Now().UTC()
	for _, c := range []struct {
		since string
		want  string
		note  bool
	}{
		{"1h", "1", false},
		{"24h", "24", false},
		{"7d", "168", false},
		{"30m", "1", true},
		{now.Add(-90 * time.Minute).Format(time.RFC3339), "2", true},
	} {
		seen := fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, timelineReply(t, []timelineRow{}, []timelineRow{}, timelineSummary(0, 0, 0, 0))
		})
		out, err := handleTimeline(ctxFor("c1"), args{"since_time": c.since}, bearer())
		if err != nil {
			t.Fatalf("%s: %v", c.since, err)
		}
		if got := (*seen)[0].URL.Query().Get("hours"); got != c.want {
			t.Errorf("since_time=%s: hours=%s, want %s", c.since, got, c.want)
		}
		if _, has := decode(t, out)["window_note"]; has != c.note {
			t.Errorf("since_time=%s: window_note present=%v, want %v", c.since, has, c.note)
		}
	}
}

func TestTimeline_ARangeThatReadsNothingIsRefused(t *testing.T) {
	now := time.Now().UTC()
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, "{}" })
	for name, a := range map[string]args{
		"start after end":      {"since_time": now.Add(-time.Hour).Format(time.RFC3339), "until_time": now.Add(-2 * time.Hour).Format(time.RFC3339)},
		"start in the future":  {"since_time": now.Add(time.Hour).Format(time.RFC3339)},
		"past what hours hold": {"since_time": "0001-01-01T00:00:00Z"},
		"past ninety days":     {"since_time": now.Add(-91 * 24 * time.Hour).Format(time.RFC3339)},
		"not a time":           {"since_time": "yesterday"},
		"end not a time":       {"until_time": "1h"},
		"name without kind":    {"namespace": "shop", "name": "web"},
		"name without ns":      {"kind": "Deployment", "name": "web"},
	} {
		if _, err := handleTimeline(ctxFor("c1"), a, bearer()); !errors.Is(err, errBadRequest) {
			t.Errorf("%s: err = %v, want a bad request", name, err)
		}
	}
	if len(*seen) != 0 {
		t.Fatalf("k8s-service was asked %d times", len(*seen))
	}
}

func TestTimeline_UntilTimeKeepsWhatCameBeforeIt(t *testing.T) {
	now := time.Now().UTC()
	until := now.Add(-3 * time.Hour)
	events := []timelineRow{
		timelineEvent("Pod", "late-1", "Normal", now.Add(-time.Hour)),
		timelineEvent("Pod", "late-2", "Normal", now.Add(-2*time.Hour)),
		timelineEvent("Pod", "early-1", "Normal", now.Add(-4*time.Hour)),
		timelineEvent("Pod", "early-2", "Normal", now.Add(-5*time.Hour)),
	}
	rollouts := []timelineRow{timelineRollout("Deployment", "late", 2, now.Add(-time.Hour)), timelineRollout("Deployment", "early", 1, now.Add(-4*time.Hour))}
	window := args{"namespace": "shop", "since_time": "24h", "until_time": until.Format(time.RFC3339)}

	t.Run("the list reached past it", func(t *testing.T) {
		for _, c := range []struct {
			summary map[string]interface{}
			want    float64
		}{
			{timelineSummary(4, 4, 4, 0), 2},   // the whole window was listed
			{timelineSummary(10, 4, 10, 0), 8}, // the list was cut below it: everything newer is in the list
		} {
			seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, timelineReply(t, events, rollouts, c.summary) })
			out, err := handleTimeline(ctxFor("c1"), window, bearer())
			if err != nil {
				t.Fatal(err)
			}
			m := decode(t, out)
			if got := rowNames(t, m["events"]); !reflect.DeepEqual(got, []string{"early-1", "early-2"}) {
				t.Fatalf("events = %v", got)
			}
			if got := rowNames(t, m["rollout_history"]); !reflect.DeepEqual(got, []string{"early"}) {
				t.Fatalf("rollouts = %v", got)
			}
			if m["rollouts_total"] != float64(1) {
				t.Fatalf("rollouts_total = %v", m["rollouts_total"])
			}
			narrowed := subMap(t, m, "narrowed")
			if narrowed["events_matching"] != c.want || narrowed["events_listed"] != float64(2) || narrowed["until_time"] != until.Format(time.RFC3339) {
				t.Fatalf("narrowed = %v, want %v events", narrowed, c.want)
			}
			// 24h back from the end, three hours ago, rounded out to a whole hour
			if got := (*seen)[0].URL.Query(); got.Get("limit") != strconv.Itoa(timelineEventsMax) || got.Get("hours") != "28" {
				t.Fatalf("a narrowed read asks the most the screen lists: %v", got)
			}
		}
	})

	t.Run("the list stopped after it", func(t *testing.T) {
		fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, timelineReply(t, events[:2], rollouts, timelineSummary(10, 2, 10, 0))
		})
		out, err := handleTimeline(ctxFor("c1"), window, bearer())
		if err != nil {
			t.Fatal(err)
		}
		m := decode(t, out)
		if got := rowNames(t, m["events"]); len(got) != 0 {
			t.Fatalf("events = %v", got)
		}
		narrowed := subMap(t, m, "narrowed")
		wantNull(t, narrowed, "events_matching")
		if note, _ := m["events_note"].(string); !strings.Contains(note, "not counted") {
			t.Fatalf("events_note = %q", note)
		}
	})

	t.Run("without a start the day before it", func(t *testing.T) {
		seen := fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, timelineReply(t, []timelineRow{}, []timelineRow{}, timelineSummary(0, 0, 0, 0))
		})
		if _, err := handleTimeline(ctxFor("c1"), args{"until_time": now.Add(-48 * time.Hour).Format(time.RFC3339)}, bearer()); err != nil {
			t.Fatal(err)
		}
		// a moment past 72 hours back: the window holds at least what was asked
		if got := (*seen)[0].URL.Query().Get("hours"); got != "73" {
			t.Fatalf("hours = %s", got)
		}
	})

	t.Run("an end still to come ends now", func(t *testing.T) {
		seen := fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, timelineReply(t, events, rollouts, timelineSummary(4, 4, 4, 0))
		})
		out, err := handleTimeline(ctxFor("c1"), args{"limit": 50, "until_time": now.Add(time.Hour).Format(time.RFC3339)}, bearer())
		if err != nil {
			t.Fatal(err)
		}
		m := decode(t, out)
		if len(rowNames(t, m["events"])) != 4 || m["narrowed"] != nil || (*seen)[0].URL.Query().Get("limit") != "50" {
			t.Fatalf("answer: %v, request %s", m, (*seen)[0].URL.RawQuery)
		}
	})
}

func TestTimeline_OneObjectAsksItsOwnTimeline(t *testing.T) {
	for _, kind := range []string{"Deployment", "deployment", "deployments"} {
		seen := fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, timelineReply(t, []timelineRow{}, []timelineRow{}, timelineSummary(0, 0, 0, 0))
		})
		out, err := handleTimeline(ctxFor("c1"), args{"namespace": "shop", "kind": kind, "name": "web"}, bearer())
		if err != nil {
			t.Fatal(err)
		}
		if got := (*seen)[0].URL.Path; got != "/api/v1/namespaces/shop/timeline/Deployment/web" {
			t.Fatalf("kind %s: path %s", kind, got)
		}
		m := decode(t, out)
		if m["narrowed"] != nil {
			t.Fatalf("the API itself narrows to an object: %v", m["narrowed"])
		}
		if got := m["object"]; !reflect.DeepEqual(got, map[string]interface{}{"kind": "Deployment", "name": "web"}) {
			t.Fatalf("object = %v", got)
		}
	}
}

func TestTimeline_AKindAloneKeepsThatKindOfWhatWasRead(t *testing.T) {
	now := time.Now().UTC()
	events := []timelineRow{timelineEvent("Pod", "p1", "Normal", now), timelineEvent("Deployment", "d1", "Normal", now), timelineEvent("Pod", "p2", "Normal", now)}
	rollouts := []timelineRow{timelineRollout("Deployment", "d1", 2, now), timelineRollout("StatefulSet", "s1", 1, now)}

	t.Run("a whole list counts them", func(t *testing.T) {
		seen := fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, timelineReply(t, events, rollouts, timelineSummary(3, 3, 3, 0))
		})
		out, err := handleTimeline(ctxFor("c1"), args{"namespace": "shop", "kind": "deployments"}, bearer())
		if err != nil {
			t.Fatal(err)
		}
		r := (*seen)[0]
		if r.URL.Path != "/api/v1/namespaces/shop/timeline" || r.URL.Query().Get("limit") != strconv.Itoa(timelineEventsMax) {
			t.Fatalf("request: %s %s", r.URL.Path, r.URL.RawQuery)
		}
		m := decode(t, out)
		if got := rowNames(t, m["events"]); !reflect.DeepEqual(got, []string{"d1"}) {
			t.Fatalf("events = %v", got)
		}
		if got := rowNames(t, m["rollout_history"]); !reflect.DeepEqual(got, []string{"d1"}) {
			t.Fatalf("rollouts = %v", got)
		}
		narrowed := subMap(t, m, "narrowed")
		if narrowed["kind"] != "Deployment" || narrowed["events_matching"] != float64(1) || m["rollouts_total"] != float64(1) {
			t.Fatalf("answer: %v", m)
		}
	})

	t.Run("a cut list does not", func(t *testing.T) {
		fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, timelineReply(t, events, rollouts, timelineSummary(30, 3, 30, 0))
		})
		out, err := handleTimeline(ctxFor("c1"), args{"kind": "Deployment"}, bearer())
		if err != nil {
			t.Fatal(err)
		}
		m := decode(t, out)
		wantNull(t, subMap(t, m, "narrowed"), "events_matching")
		if note, _ := m["events_note"].(string); !strings.Contains(note, "not counted") {
			t.Fatalf("events_note = %q", note)
		}
	})
}

func TestTimeline_LimitIsTheNewestRowsUpToTheScreens(t *testing.T) {
	now := time.Now().UTC()
	for _, c := range []struct {
		limit interface{}
		want  string
	}{{50, "50"}, {500, "500"}, {9999, "500"}, {0, "200"}, {-1, "200"}} {
		seen := fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, timelineReply(t, []timelineRow{}, []timelineRow{}, timelineSummary(0, 0, 0, 0))
		})
		if _, err := handleTimeline(ctxFor("c1"), args{"limit": c.limit}, bearer()); err != nil {
			t.Fatal(err)
		}
		if got := (*seen)[0].URL.Query().Get("limit"); got != c.want {
			t.Errorf("limit %v: asked %s, want %s", c.limit, got, c.want)
		}
	}
	// a narrowed read asks for more than it lists, so it cuts what it keeps itself
	events := []timelineRow{timelineEvent("Pod", "new", "Normal", now.Add(-4*time.Hour)), timelineEvent("Pod", "old", "Normal", now.Add(-5*time.Hour))}
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, timelineReply(t, events, []timelineRow{}, timelineSummary(2, 2, 2, 0))
	})
	out, err := handleTimeline(ctxFor("c1"), args{"limit": 1, "until_time": now.Add(-3 * time.Hour).Format(time.RFC3339)}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if got := rowNames(t, m["events"]); !reflect.DeepEqual(got, []string{"new"}) {
		t.Fatalf("events = %v", got)
	}
	narrowed := subMap(t, m, "narrowed")
	if narrowed["events_matching"] != float64(2) || narrowed["events_listed"] != float64(1) {
		t.Fatalf("narrowed = %v", narrowed)
	}
	if note, _ := m["events_note"].(string); !strings.Contains(note, "newest 1 of the 2") {
		t.Fatalf("events_note = %q", note)
	}
}

func TestTimeline_ARefusalIsAnAnswer(t *testing.T) {
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		{403, `{"detail":"namespace \"db\" is outside your grant"}`, "forbidden"},
		{429, `{"detail":"too many"}`, "rate_limited"},
	} {
		fakeK8sService(t, func(*http.Request) (int, string) { return c.status, c.body })
		out, err := handleTimeline(ctxFor("c1"), args{"namespace": "db"}, bearer())
		if err != nil {
			t.Fatalf("%d: %v", c.status, err)
		}
		if m := decode(t, out); m["status"] != c.want || m["feature"] != "timeline" {
			t.Fatalf("%d: %v", c.status, m)
		}
	}
	fakeK8sService(t, func(*http.Request) (int, string) { return 500, `{"detail":"boom"}` })
	if _, err := handleTimeline(ctxFor("c1"), args{}, bearer()); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("a failure is an error: %v", err)
	}
}

func TestTimeline_TheSummaryComesBeforeTheRows(t *testing.T) {
	now := time.Now().UTC()
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, timelineReply(t, []timelineRow{timelineEvent("Pod", "a", "Normal", now)}, []timelineRow{timelineRollout("Deployment", "web", 1, now)}, timelineSummary(9, 1, 9, 0))
	})
	out, err := handleTimeline(ctxFor("c1"), args{"limit": 1}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	at := func(key string) int { return strings.Index(out, `"`+key+`":`) }
	if !(at("summary") < at("events_note") && at("events_note") < at("rollouts_total") && at("rollouts_total") < at("rollout_history") && at("rollout_history") < at("events")) {
		t.Fatalf("a model's cut must keep the counts: %s", out)
	}
}

func TestTimeline_NothingInTheWindowSaysWhyThatMayBe(t *testing.T) {
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, timelineReply(t, []timelineRow{}, []timelineRow{}, timelineSummary(0, 0, 0, 0))
	})
	out, err := handleTimeline(ctxFor("c1"), args{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if hint, _ := decode(t, out)["hint"].(string); !strings.Contains(hint, "TTL") {
		t.Fatalf("hint = %q", hint)
	}
}

func TestTimeline_EventTypeIsOneOfTheTwoTheAPITakes(t *testing.T) {
	for _, ok := range []string{"Normal", "Warning"} {
		if err := validateToolArgs(args{"event_type": ok}); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	// the API lists both for a word it does not know: a typo must not read as a filter
	for _, bad := range []string{"warning", "Error", "Warning,Normal"} {
		if err := validateToolArgs(args{"event_type": bad}); err == nil {
			t.Errorf("%s passed", bad)
		}
	}
}
