package handler

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// secretWatchCall is what one Secret watch asked the API server for.
type secretWatchCall struct {
	namespace, resourceVersion string
	bookmarks                  bool
}

// scriptedSecretWatches answers each Secret watch through answer, with the how-manieth watch of its namespace this is,
// and keeps what each asked for.
type scriptedSecretWatches struct {
	mu     sync.Mutex
	calls  []secretWatchCall
	answer func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int)
}

func (a *scriptedSecretWatches) serve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("watch") != "true" || !strings.HasSuffix(r.URL.Path, "/secrets") {
		http.NotFound(w, r)
		return
	}
	namespace := ""
	if rest, ok := strings.CutPrefix(r.URL.Path, "/api/v1/namespaces/"); ok {
		namespace = strings.TrimSuffix(rest, "/secrets")
	}
	call := secretWatchCall{namespace: namespace, resourceVersion: q.Get("resourceVersion"), bookmarks: q.Get("allowWatchBookmarks") == "true"}
	a.mu.Lock()
	n := 0
	for _, c := range a.calls {
		if c.namespace == namespace {
			n++
		}
	}
	a.calls = append(a.calls, call)
	a.mu.Unlock()
	a.answer(w, r, call, n)
}

func (a *scriptedSecretWatches) made() []secretWatchCall {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]secretWatchCall(nil), a.calls...)
}

// watchEvents starts a watch's answer, unless it has started, and writes its events, one JSON line each.
func watchEvents(w http.ResponseWriter, lines ...string) {
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
	}
	for _, line := range lines {
		fmt.Fprintln(w, line)
	}
	w.(http.Flusher).Flush()
}

// releaseEvent is a watch event of a Helm release Secret, as Helm stores it: the release's JSON in base64 under
// "release", which the API server's JSON carries in base64 again.
func releaseEvent(kind, namespace, name string, revision int, version string) string {
	release := fmt.Sprintf(`{"name":%q,"namespace":%q,"version":%d,"info":{"status":"deployed"}}`, name, namespace, revision)
	data := base64.StdEncoding.EncodeToString([]byte(base64.StdEncoding.EncodeToString([]byte(release))))
	return fmt.Sprintf(`{"type":%q,"object":{"kind":"Secret","apiVersion":"v1","metadata":{"name":"sh.helm.release.v1.%s.v%d","namespace":%q,"resourceVersion":%q},"type":"helm.sh/release.v1","data":{"release":%q}}}`,
		kind, name, revision, namespace, version, data)
}

func bookmarkEvent(version string) string {
	return fmt.Sprintf(`{"type":"BOOKMARK","object":{"kind":"Secret","apiVersion":"v1","metadata":{"resourceVersion":%q}}}`, version)
}

const expiredEvent = `{"type":"ERROR","object":{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"too old resource version","reason":"Expired","code":410}}`

// helmEvents opens a page's Helm releases stream with the request's header and query, and reads its events: a data
// frame by its event's name ("" for a release's), an id line as "id".
func helmEvents(t *testing.T, h *Handler, namespaces []string, query string, header http.Header) <-chan sseEvent {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := cluster.WithID(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u", Perms: auth.PermissionMatrix{"*": {"*"}}, Namespaces: map[string][]string{"c": namespaces}}), "c")
		h.WatchHelmReleases(w, r.WithContext(ctx))
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/?"+query, nil)
	for name, values := range header {
		req.Header[name] = values
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	events := make(chan sseEvent, 256)
	go func() {
		defer close(events)
		sc := bufio.NewScanner(resp.Body)
		name := ""
		for sc.Scan() {
			switch line := sc.Text(); {
			case strings.HasPrefix(line, "id: "):
				events <- sseEvent{"id", strings.TrimPrefix(line, "id: ")}
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				events <- sseEvent{name, strings.TrimPrefix(line, "data: ")}
				name = ""
			}
		}
	}()
	return events
}

// eventsUntil reads events until one done says so, and fails after five seconds.
func eventsUntil(t *testing.T, events <-chan sseEvent, done func(sseEvent) bool) []sseEvent {
	t.Helper()
	var got []sseEvent
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e, ok := <-events:
			if !ok {
				t.Fatalf("stream closed after %v", got)
			}
			got = append(got, e)
			if done(e) {
				return got
			}
		case <-deadline:
			t.Fatalf("waited five seconds, got %v", got)
		}
	}
}

// what reads a stream's events as one line each: "resync", "id", and a release's as its type and name.
func what(events []sseEvent) []string {
	out := make([]string, 0, len(events))
	for _, e := range events {
		switch e.name {
		case "":
			kind, _, _ := strings.Cut(strings.TrimPrefix(e.data, `{"type":"`), `"`)
			_, rest, _ := strings.Cut(e.data, `"name":"`)
			name, _, _ := strings.Cut(rest, `"`)
			out = append(out, kind+" "+name)
		default:
			out = append(out, e.name)
		}
	}
	return out
}

func quickHelmResume(t *testing.T) {
	resume := helmResumeDelay
	helmResumeDelay = func() time.Duration { return 10 * time.Millisecond }
	t.Cleanup(func() { helmResumeDelay = resume })
}

// A watch of the stream that ends (its timeout, a bookmark's version) goes on from the last version it brought, so a
// release deleted in between still reaches the page as DELETED and nothing is read again. Only when the API server says
// that version has expired does the next watch start from none, and the page is told once that watch is on.
func TestAHelmStreamGoesOnFromItsVersionAndAsksForAReadOnlyWhenItExpired(t *testing.T) {
	quickHelmResume(t)
	api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
		switch n {
		case 0:
			watchEvents(w, releaseEvent("ADDED", "team", "web", 1, "10"), releaseEvent("ADDED", "team", "db", 1, "11"), bookmarkEvent("15"))
		case 1:
			watchEvents(w, releaseEvent("DELETED", "team", "db", 1, "16"))
		case 2:
			watchEvents(w, expiredEvent)
		default:
			watchEvents(w, releaseEvent("ADDED", "team", "web", 1, "10"))
			<-r.Context().Done()
		}
	}}
	h, _ := liveHandler(t, api.serve, &atomic.Int32{})
	events := helmEvents(t, h, nil, "", nil)

	got := what(eventsUntil(t, events, func(e sseEvent) bool { return e.name == "resync" }))
	got = append(got, what(eventsUntil(t, events, func(e sseEvent) bool { return e.name == "" }))...)
	want := []string{"id", "ADDED web", "ADDED db", "DELETED db", "resync", "ADDED web"}
	if strings.Join(got, ", ") != strings.Join(want, ", ") {
		t.Errorf("the stream said %v, want %v", got, want)
	}
	calls := api.made()
	if len(calls) < 4 {
		t.Fatalf("%d watches, want 4", len(calls))
	}
	for i, from := range []string{"", "15", "16", ""} {
		if calls[i].resourceVersion != from || !calls[i].bookmarks {
			t.Errorf("watch %d asked for %+v, want resourceVersion %q with bookmarks", i, calls[i], from)
		}
	}
}

// The API server can refuse an expired version as the watch's answer, not as an event of it: the same read again.
func TestAHelmWatchRefusedForAnExpiredVersionStartsOverAndAsksForARead(t *testing.T) {
	quickHelmResume(t)
	api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
		switch {
		case n == 0:
			watchEvents(w, releaseEvent("ADDED", "team", "web", 1, "10"))
		case call.resourceVersion != "":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusGone)
			fmt.Fprint(w, `{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"too old resource version","reason":"Expired","code":410}`)
		default:
			watchEvents(w, releaseEvent("ADDED", "team", "web", 1, "40"))
			<-r.Context().Done()
		}
	}}
	h, _ := liveHandler(t, api.serve, &atomic.Int32{})
	events := helmEvents(t, h, nil, "", nil)

	got := what(eventsUntil(t, events, func(e sseEvent) bool { return e.name == "resync" }))
	got = append(got, what(eventsUntil(t, events, func(e sseEvent) bool { return e.name == "" }))...)
	if want := "id, ADDED web, resync, ADDED web"; strings.Join(got, ", ") != want {
		t.Errorf("the stream said %v, want %s", got, want)
	}
	if calls := api.made(); len(calls) < 3 || calls[1].resourceVersion != "10" || calls[2].resourceVersion != "" {
		t.Errorf("watches %+v, want from no version, then 10, then none", calls)
	}
}

// A stream knows nothing of the one before it. The browser opening it again by itself sends the stream's id back, and a
// page whose list was read before the stream opened says resync=1: either gets one resync once the watch is on, as a
// socket's REQUEST with resync gets one RESYNC. A stream the page opened on a list it has just read gets none.
func TestAHelmStreamOpenedAgainAsksForOneReadOnceItsWatchIsOn(t *testing.T) {
	quickHelmResume(t)
	for _, c := range []struct {
		name   string
		query  string
		header http.Header
		want   string
	}{
		{"opened on a list just read", "", nil, "id, ADDED web"},
		{"opened again by the browser", "", http.Header{"Last-Event-Id": {helmStreamID}}, "id, resync, ADDED web"},
		{"opened on a list read before", "resync=1", nil, "id, resync, ADDED web"},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
				watchEvents(w, releaseEvent("ADDED", "team", "web", 1, "10"))
				<-r.Context().Done()
			}}
			h, _ := liveHandler(t, api.serve, &atomic.Int32{})
			got := what(eventsUntil(t, helmEvents(t, h, nil, c.query, c.header), func(e sseEvent) bool { return e.name == "" }))
			if strings.Join(got, ", ") != c.want {
				t.Errorf("the stream said %v, want %s", got, c.want)
			}
		})
	}
}

// A grant limited to namespaces has one watch per namespace, each going on from its own version: a bookmark names no
// namespace, so the one its watch follows keeps it.
func TestEachNamespaceWatchOfAHelmStreamGoesOnFromItsOwnVersion(t *testing.T) {
	quickHelmResume(t)
	bookmarked := make(chan struct{})
	api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
		switch {
		case n > 0:
			watchEvents(w)
			<-r.Context().Done()
		case call.namespace == "team-b":
			watchEvents(w, bookmarkEvent("25"))
			close(bookmarked)
			<-r.Context().Done()
		default:
			// answers at once, so team-b's watch opens too, and ends the watches after team-b's bookmark has gone through
			watchEvents(w)
			<-bookmarked
			time.Sleep(100 * time.Millisecond)
			watchEvents(w, releaseEvent("ADDED", "team-a", "web", 1, "20"))
		}
	}}
	h, _ := liveHandler(t, api.serve, &atomic.Int32{})
	events := helmEvents(t, h, []string{"team-a", "team-b"}, "", nil)
	eventsUntil(t, events, func(e sseEvent) bool { return e.name == "" })

	if !eventuallyTrue(5*time.Second, func() bool { return len(api.made()) >= 4 }) {
		t.Fatalf("watches %+v, want each namespace's twice", api.made())
	}
	from := map[string]string{}
	for _, c := range api.made()[2:] {
		from[c.namespace] = c.resourceVersion
	}
	if from["team-a"] != "20" || from["team-b"] != "25" {
		t.Errorf("the second watches went on from %v, want team-a from 20 and team-b from 25", from)
	}
}
