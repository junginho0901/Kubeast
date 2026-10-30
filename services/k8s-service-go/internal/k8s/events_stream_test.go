package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// pagedAPI answers events and pods lists in pages of the asked limit with continue tokens, as the API server does,
// and records each list request; expireAfter > 0 answers 410 Expired to a continue token past that many items.
type pagedAPI struct {
	mu          sync.Mutex
	events      []corev1.Event
	pods        []corev1.Pod
	asked       []listCall
	expireAfter int
}

type listCall struct {
	path, fieldSelector string
	limit               int
	cont                string
}

func (a *pagedAPI) serve(t *testing.T) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		a.mu.Lock()
		a.asked = append(a.asked, listCall{path: r.URL.Path, fieldSelector: q.Get("fieldSelector"), limit: limit, cont: q.Get("continue")})
		a.mu.Unlock()
		from, _ := strconv.Atoi(q.Get("continue"))
		if a.expireAfter > 0 && from > a.expireAfter {
			w.WriteHeader(http.StatusGone)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Expired","code":410}`))
			return
		}
		page := func(n int) (int, int, metav1.ListMeta) {
			to := n
			if limit > 0 && from+limit < n {
				to = from + limit
			}
			meta := metav1.ListMeta{}
			if to < n {
				meta.Continue = strconv.Itoa(to)
				rest := int64(n - to)
				meta.RemainingItemCount = &rest
			}
			return from, to, meta
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/events"):
			items := a.events
			if fs := q.Get("fieldSelector"); fs == "type=Warning" {
				items = nil
				for _, e := range a.events {
					if e.Type == corev1.EventTypeWarning {
						items = append(items, e)
					}
				}
			}
			f, to, meta := page(len(items))
			_ = json.NewEncoder(w).Encode(corev1.EventList{TypeMeta: metav1.TypeMeta{Kind: "EventList", APIVersion: "v1"}, ListMeta: meta, Items: items[f:to]})
		case strings.HasSuffix(r.URL.Path, "/pods"):
			f, to, meta := page(len(a.pods))
			_ = json.NewEncoder(w).Encode(corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, ListMeta: meta, Items: a.pods[f:to]})
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		}
	}))
	t.Cleanup(srv.Close)
	k, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: k})
	return s
}

// events: n events, the i-th last seen i minutes before now, every third a Warning, about objects pod-0 … pod-9.
func someEvents(n int, now time.Time) []corev1.Event {
	out := make([]corev1.Event, n)
	for i := range out {
		typ := corev1.EventTypeNormal
		if i%3 == 0 {
			typ = corev1.EventTypeWarning
		}
		out[i] = corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Name: fmt.Sprintf("e-%d", i), Namespace: "bulk"},
			InvolvedObject: corev1.ObjectReference{Kind: "Pod", Namespace: "bulk", Name: fmt.Sprintf("pod-%d", i%10)},
			Type:           typ,
			Reason:         fmt.Sprintf("R%d", i),
			LastTimestamp:  metav1.NewTime(now.Add(-time.Duration(i) * time.Minute)),
			Count:          int32(i + 1),
		}
	}
	return out
}

func TestNewestEventsAreReadAPageAtATime(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	api := &pagedAPI{events: someEvents(1234, now)}
	s := api.serve(t)
	// the newest 100 of the last 600 minutes (events 0 … 599 are inside)
	got, counts, err := s.newestEventsSince(context.Background(), "", metav1.ListOptions{}, now.Add(-599*time.Minute-time.Second), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 100 || got[0].Name != "e-0" || got[99].Name != "e-99" {
		t.Fatalf("kept %d, first %s, last %s", len(got), got[0].Name, got[len(got)-1].Name)
	}
	if !sort.SliceIsSorted(got, func(i, j int) bool { return eventTimestamp(got[i]).After(eventTimestamp(got[j])) }) {
		t.Fatal("not newest first")
	}
	if counts.Total != 600 || counts.Warning != 200 {
		t.Fatalf("counts %+v, want 600 in the window, 200 of them Warning", counts)
	}
	// three pages of at most 500, never one list without a limit
	if len(api.asked) != 3 {
		t.Fatalf("requests %+v", api.asked)
	}
	for _, a := range api.asked {
		if a.limit != eventPageSize {
			t.Fatalf("a request without the page limit: %+v", a)
		}
	}
	// no limit: all of the window
	all, _, err := s.newestEventsSince(context.Background(), "", metav1.ListOptions{}, time.Time{}, 0)
	if err != nil || len(all) != 1234 {
		t.Fatalf("no limit: %d, %v", len(all), err)
	}
}

func TestAnExpiredPageIsAnErrorNotOneFullList(t *testing.T) {
	api := &pagedAPI{events: someEvents(1600, time.Now()), expireAfter: 500}
	s := api.serve(t)
	_, _, err := s.newestEventsSince(context.Background(), "", metav1.ListOptions{}, time.Time{}, 10)
	if err == nil {
		t.Fatal("an expired continue token must be an error")
	}
	for _, a := range api.asked {
		if a.limit == 0 {
			t.Fatalf("fell back to one full list: %+v", api.asked)
		}
	}
}

func TestGetEventsNewestAndTheTotal(t *testing.T) {
	now := time.Now()
	api := &pagedAPI{events: someEvents(1234, now)}
	s := api.serve(t)
	rows, total, err := s.GetEvents(context.Background(), "bulk", "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 10 || total != 1234 || rows[0]["name"] != "e-0" || rows[0]["type"] != corev1.EventTypeWarning {
		t.Fatalf("rows %d total %d first %v", len(rows), total, rows[0])
	}
	if api.asked[0].path != "/api/v1/namespaces/bulk/events" {
		t.Fatalf("path %s", api.asked[0].path)
	}
	// a resource name and a field selector go to the API server together
	api.asked = nil
	if _, _, err := s.GetEvents(context.Background(), "", "web-1", "type=Warning", 10); err != nil {
		t.Fatal(err)
	}
	if api.asked[0].path != "/api/v1/events" || api.asked[0].fieldSelector != "involvedObject.name=web-1,type=Warning" {
		t.Fatalf("asked %+v", api.asked[0])
	}
}

func TestTimelineCountsEveryEventInTheWindow(t *testing.T) {
	now := time.Now()
	api := &pagedAPI{events: someEvents(1234, now)}
	s := api.serve(t)
	events, counts, err := s.getTimelineEvents(context.Background(), "", "", "", now.Add(-24*time.Hour), 500)
	if err != nil {
		t.Fatal(err)
	}
	res := buildTimelineResult(events, counts, nil, now.Add(-24*time.Hour))
	// 1 234 minutes is under a day: every event is in the window; the list holds the newest 500
	if res.Summary["total_events"] != 1234 || res.Summary["events_shown"] != 500 || res.Summary["warning_count"] != 412 ||
		res.Summary["normal_count"] != 822 || len(res.Events) != 500 {
		t.Fatalf("summary %v, events %d", res.Summary, len(res.Events))
	}
}

func TestIssuesReadPodsAPageAtATimeAndWarningsOnly(t *testing.T) {
	now := time.Now()
	pods := make([]corev1.Pod, 1200)
	for i := range pods {
		phase := corev1.PodRunning
		if i%100 == 0 {
			phase = corev1.PodPending
		}
		pods[i] = corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("p-%d", i), Namespace: "bulk"}, Status: corev1.PodStatus{Phase: phase}}
	}
	api := &pagedAPI{pods: pods, events: someEvents(1234, now)}
	s := api.serve(t)
	opts := IssuesOptions{Now: now, Window: time.Hour}
	got, err := s.podIssues(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	want := issuesFromPods(formatPodList(pods), opts)
	if len(got) != len(want) || len(got) != 12 {
		t.Fatalf("issues %d, as one list %d", len(got), len(want))
	}
	for i := range want {
		if got[i].ID != want[i].ID || got[i].Severity != want[i].Severity {
			t.Fatalf("issue %d: %+v, want %+v", i, got[i], want[i])
		}
	}
	for _, a := range api.asked {
		if a.limit != podListChunk {
			t.Fatalf("a pod list without the page limit: %+v", a)
		}
	}

	api.asked = nil
	rows, err := s.warningEventRows(context.Background(), now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if api.asked[0].fieldSelector != "type=Warning" {
		t.Fatalf("the API server is not asked for Warnings only: %+v", api.asked[0])
	}
	// Warnings of the last hour are events 0, 3, … 57 about pod-0 … pod-9: the newest of each object, ten rows
	if len(rows) != 10 {
		t.Fatalf("rows %d", len(rows))
	}
	for _, r := range rows {
		obj := r["involved_object"].(map[string]interface{})
		if r["type"] != corev1.EventTypeWarning || !strings.HasPrefix(obj["name"].(string), "pod-") {
			t.Fatalf("row %v", r)
		}
	}
	if rows[0]["name"] != "e-0" {
		t.Fatalf("pod-0's newest Warning is e-0, got %v", rows[0]["name"])
	}
}
