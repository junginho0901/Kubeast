package k8s

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// eventsAPI serves the ConfigMap shop/app and the events about it as an API server does, refuses the events to the
// users in refuse, and holds each list of events until hold closes.
type eventsAPI struct {
	hold   chan struct{}
	refuse map[string]bool
	mu     sync.Mutex
	now    int
	most   int
	lists  int
}

func (a *eventsAPI) listsOfEvents() (now, most, all int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.now, a.most, a.lists
}

func (a *eventsAPI) serve(w http.ResponseWriter, r *http.Request) {
	user := r.Header.Get(auth.HeaderImpersonateUser)
	made := metav1.NewTime(time.Date(2026, 11, 1, 2, 3, 4, 0, time.UTC))
	switch r.URL.Path {
	case "/api/v1/namespaces/shop/configmaps/app":
		writeJSON(w, &corev1.ConfigMap{
			TypeMeta:   metav1.TypeMeta{Kind: "ConfigMap", APIVersion: "v1"},
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "shop", UID: "c0f1", ResourceVersion: "5", CreationTimestamp: made},
			Data:       map[string]string{"mode": "fast"},
		})
	case "/api/v1/namespaces/shop/events":
		a.mu.Lock()
		a.now++
		a.lists++
		a.most = max(a.most, a.now)
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			a.now--
			a.mu.Unlock()
		}()
		if a.hold != nil {
			select {
			case <-a.hold:
			case <-r.Context().Done():
				return
			}
		}
		if a.refuse[user] {
			writeStatus(w, http.StatusForbidden, "Forbidden", fmt.Sprintf("events is forbidden: User %q cannot list resource \"events\" in the namespace \"shop\"", user))
			return
		}
		list := &corev1.EventList{TypeMeta: metav1.TypeMeta{Kind: "EventList", APIVersion: "v1"}}
		if r.URL.Query().Get("fieldSelector") == "involvedObject.name=app,involvedObject.kind=ConfigMap" {
			for i, reason := range []string{"Updated", "Synced", "Rejected"} {
				at := metav1.NewTime(made.Add(time.Duration(i*7%3) * time.Minute))
				list.Items = append(list.Items, corev1.Event{
					ObjectMeta:     metav1.ObjectMeta{Name: "app." + reason, Namespace: "shop"},
					InvolvedObject: corev1.ObjectReference{Kind: "ConfigMap", Name: "app", Namespace: "shop", UID: "c0f1"},
					Reason:         reason, Message: reason + " by the controller", Type: corev1.EventTypeNormal, Count: int32(i + 1),
					FirstTimestamp: made, LastTimestamp: at, Source: corev1.EventSource{Component: "controller"},
				})
			}
		}
		writeJSON(w, list)
	default:
		http.NotFound(w, r)
	}
}

// start serves a to a bundle that calls it as each caller.
func (a *eventsAPI) start(t *testing.T) (*Service, *kubernetes.Clientset) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(srv.Close)
	cfg := &rest.Config{Host: srv.URL, QPS: -1}
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return auth.ImpersonationRoundTripper(rt, "default") })
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{cache: cache.New("", 0, 0, "")}
	s.defaultBundle.Store(&clientBundle{clientset: cs, authz: cs.AuthorizationV1(), id: "default"})
	return s, cs
}

// ownEvents is what a describe says of the events the caller's own list gives.
func ownEvents(t *testing.T, cs *kubernetes.Clientset, ctx context.Context) string {
	t.Helper()
	events, err := cs.CoreV1().Events("shop").List(ctx, metav1.ListOptions{FieldSelector: "involvedObject.name=app,involvedObject.kind=ConfigMap"})
	want := map[string]interface{}{}
	setEvents(want, events, err, about())
	return answerJSON(t, map[string]interface{}{"events": want["events"], "events_error": want["events_error"]})
}

// Thirty different people opening a drawer at one moment list its events four at a time on the cluster, and each
// drawer says what that person's own list of them says.
func TestDescribeEventListsOfACrowdTakeTurns(t *testing.T) {
	api := &eventsAPI{hold: make(chan struct{}), refuse: map[string]bool{"u03@example.com": true, "u17@example.com": true}}
	s, cs := api.start(t)
	answers := make([]map[string]interface{}, 30)
	errs := make([]error, 30)
	var wg sync.WaitGroup
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i], errs[i] = s.DescribeConfigMap(wideCaller(fmt.Sprintf("u%02d@example.com", i)), "shop", "app")
		}()
	}
	eventually(t, 5*time.Second, func() bool { now, _, _ := api.listsOfEvents(); return now >= 4 })
	time.Sleep(300 * time.Millisecond)
	_, most, _ := api.listsOfEvents()
	close(api.hold)
	wg.Wait()
	t.Logf("30 drawers at once: %d lists of events at the same time", most)
	if most > 4 {
		t.Errorf("%d lists of events at once, want at most 4", most)
	}
	for i, got := range answers {
		if errs[i] != nil || got["name"] != "app" {
			t.Fatalf("drawer %d: %v %v", i, got["name"], errs[i])
		}
		gotEvents := answerJSON(t, map[string]interface{}{"events": got["events"], "events_error": got["events_error"]})
		if want := ownEvents(t, cs, wideCaller(fmt.Sprintf("u%02d@example.com", i))); gotEvents != want {
			t.Errorf("drawer %d:\n got %s\nwant %s", i, gotEvents, want)
		}
	}
}

// A drawer whose request ends while the cluster's lists of events are all taken lists none and says why it has no events.
func TestADescribeWaitingForAnEventListEndsWithItsRequest(t *testing.T) {
	api := &eventsAPI{hold: make(chan struct{})}
	s, _ := api.start(t)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = s.DescribeConfigMap(wideCaller(fmt.Sprintf("u%02d@example.com", i)), "shop", "app")
		}()
	}
	defer func() { close(api.hold); wg.Wait() }()
	if !eventually(t, 5*time.Second, func() bool { now, _, _ := api.listsOfEvents(); return now >= 4 }) {
		t.Fatal("the four lists never started")
	}
	ctx, cancel := context.WithTimeout(wideCaller("late@example.com"), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	got, err := s.DescribeConfigMap(ctx, "shop", "app")
	took := time.Since(start)
	_, _, all := api.listsOfEvents()
	if err != nil || got["name"] != "app" || got["events"] != nil || !strings.Contains(fmt.Sprint(got["events_error"]), "deadline") || took > 2*time.Second || all != 4 {
		t.Errorf("the drawer that left: %v after %v, events %v, events_error %q, lists of events %d (want the four)", err, took, got["events"], got["events_error"], all)
	}
}

// Every list of the events about one object takes its turn among the cluster's places through objectEvents.
func TestEveryDescribeEventsListTakesItsTurn(t *testing.T) {
	list := regexp.MustCompile(`Events\([^)]*\)\.List\(`)
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		// events_stream.go is the events API and the timeline, read a page at a time
		if strings.HasSuffix(f, "_test.go") || f == "object_events.go" || f == "events_stream.go" {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, loc := range list.FindAllIndex(b, -1) {
			t.Errorf("%s:%d lists events outside objectEvents", f, strings.Count(string(b[:loc[0]]), "\n")+1)
		}
	}
}
