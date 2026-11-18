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

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
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

// helmFrame is one frame of the stream as the browser dispatches it: its event's name ("" for a release's), its data
// ("" for a frame of an id alone) and the stream's id after it.
type helmFrame struct{ name, data, id string }

// helmFrames opens a page's Helm releases stream with the request's header and query, and reads its frames.
func helmFrames(t *testing.T, h *Handler, namespaces []string, query string, header http.Header) <-chan helmFrame {
	t.Helper()
	return helmFramesAs(t, h, "u", namespaces, query, header)
}

// helmPerson is user's token with a grant on cluster c limited to namespaces, none being the whole cluster.
func helmPerson(ctx context.Context, user string, namespaces []string) context.Context {
	return cluster.WithID(auth.WithPayload(ctx, auth.TokenPayload{UserID: user, Perms: auth.PermissionMatrix{"*": {"*"}}, Namespaces: map[string][]string{"c": namespaces}}), "c")
}

// helmClient is how the stream names cluster c registered at version and the person reading it: an id's part before
// its versions.
func helmClient(version int64, user string, namespaces []string) string {
	return helmStreamID + "/" + clientPlace("c", version) + "/" + personTag(helmPerson(context.Background(), user, namespaces), "c")
}

// helmFramesAs is helmFrames as user.
func helmFramesAs(t *testing.T, h *Handler, user string, namespaces []string, query string, header http.Header) <-chan helmFrame {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.WatchHelmReleases(w, r.WithContext(helmPerson(r.Context(), user, namespaces)))
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
	frames := make(chan helmFrame, 256)
	go func() {
		defer close(frames)
		sc := bufio.NewScanner(resp.Body)
		var f helmFrame
		hasID := false
		for sc.Scan() {
			switch line := sc.Text(); {
			case line == "":
				if f.data != "" || hasID {
					frames <- f
				}
				f, hasID = helmFrame{id: f.id}, false
			case strings.HasPrefix(line, "id: "):
				f.id, hasID = strings.TrimPrefix(line, "id: "), true
			case strings.HasPrefix(line, "event: "):
				f.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				f.data = strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return frames
}

// helmEvents reads a page's Helm releases stream as events: a data frame by its event's name ("" for a release's), a
// frame of an id alone as "id".
func helmEvents(t *testing.T, h *Handler, namespaces []string, query string, header http.Header) <-chan sseEvent {
	t.Helper()
	frames := helmFrames(t, h, namespaces, query, header)
	events := make(chan sseEvent, 256)
	go func() {
		defer close(events)
		for f := range frames {
			if f.data == "" {
				events <- sseEvent{"id", f.id}
			} else {
				events <- sseEvent{f.name, f.data}
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
	// the second id tells the browser its id names no version any more
	want := []string{"id", "ADDED web", "ADDED db", "DELETED db", "id", "resync", "ADDED web"}
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

// A stream opened again by the browser with an id that names no version (the one before ended before its first event,
// or a server of 0.7.7 wrote it) knows nothing of the one before it, and a page whose list was read before the stream
// opened says resync=1: either gets one resync once the watch is on, as a socket's REQUEST with resync gets one RESYNC.
// A stream the page opened on a list it has just read gets none.
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

// framesUntil reads frames until one done says so, and fails after five seconds.
func framesUntil(t *testing.T, frames <-chan helmFrame, done func(helmFrame) bool) []helmFrame {
	t.Helper()
	var got []helmFrame
	deadline := time.After(5 * time.Second)
	for {
		select {
		case f, ok := <-frames:
			if !ok {
				t.Fatalf("stream closed after %+v", got)
			}
			got = append(got, f)
			if done(f) {
				return got
			}
		case <-deadline:
			t.Fatalf("waited five seconds, got %+v", got)
		}
	}
}

// said reads frames as one line each: an id alone as "id <id>", a named event by its name, a release's as its type and
// name with the id the browser has after it.
func said(frames []helmFrame) string {
	out := make([]string, 0, len(frames))
	for _, f := range frames {
		switch {
		case f.data == "":
			out = append(out, "id "+f.id)
		case f.name != "":
			out = append(out, f.name)
		default:
			out = append(out, what([]sseEvent{{"", f.data}})[0]+" @ "+f.id)
		}
	}
	return strings.Join(out, ", ")
}

// isRelease says a frame is a release's of that name.
func isRelease(name string) func(helmFrame) bool {
	return func(f helmFrame) bool { return f.name == "" && strings.Contains(f.data, `"name":"`+name+`"`) }
}

// quickHelmKeepalive writes the keepalive, and the id bookmarks moved, every 20 ms.
func quickHelmKeepalive(t *testing.T) {
	period := keepalivePeriod
	keepalivePeriod = 20 * time.Millisecond
	t.Cleanup(func() { keepalivePeriod = period })
}

// versionRegistry registers every cluster with one kubeconfig at one config_version.
type versionRegistry struct {
	blob    string
	version int64
}

func (versionRegistry) List(context.Context) ([]cluster.Info, error) { return nil, nil }
func (r versionRegistry) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	return &cluster.Info{ID: id, Mode: cluster.ModeExternal, KubeconfigBlob: r.blob, ConfigVersion: r.version}, nil
}
func (versionRegistry) Default(context.Context) (cluster.ID, error) { return "c", nil }

// helmHandlerAt is liveHandler with cluster c registered at config_version version.
func helmHandlerAt(t *testing.T, api http.HandlerFunc, version int64) *Handler {
	t.Helper()
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)
	blob := strings.Replace(middlewareKubeconfig, "https://127.0.0.1:6443", server.URL, 1)
	svc, err := k8s.NewService(context.Background(), versionRegistry{blob: blob, version: version}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{svc: svc, auditStore: &lockedAudit{}}
	h.SetLiveSessions(sessionsAt(&atomic.Int32{}))
	return h
}

// statusAnswer answers a watch with the API server's refusal.
func statusAnswer(w http.ResponseWriter, code int, status string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	fmt.Fprint(w, status)
}

const (
	goneStatus        = `{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"too old resource version","reason":"Expired","code":410}`
	unavailableStatus = `{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"the server is currently unable to handle the request","reason":"ServiceUnavailable","code":503}`
)

// The stream's id is where its watches are: the cluster's client as registered and each watch's version. A watch opened
// from no version sends each release at its own last version, in name order, which is no place to go on from, so the
// id names none until the watch's first bookmark; from then on each release's frame carries it, and the place a
// bookmark moved it to goes with the next keepalive. Two servers built from the same registration that brought the
// same events wrote the same ids, since nothing of the server is in them.
func TestAHelmStreamsIDNamesAPlaceOnceItsWatchHasOneTheSameOnEveryServer(t *testing.T) {
	quickHelmResume(t)
	quickHelmKeepalive(t)
	ids := func() string {
		api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
			watchEvents(w, releaseEvent("ADDED", "team", "web", 1, "12"), releaseEvent("ADDED", "team", "db", 1, "9"))
			time.Sleep(50 * time.Millisecond)
			watchEvents(w, bookmarkEvent("15"))
			time.Sleep(100 * time.Millisecond)
			watchEvents(w, releaseEvent("MODIFIED", "team", "web", 2, "16"))
			<-r.Context().Done()
		}}
		h := helmHandlerAt(t, api.serve, 3)
		return said(framesUntil(t, helmFrames(t, h, nil, "", nil), func(f helmFrame) bool { return strings.Contains(f.data, `"MODIFIED"`) }))
	}
	at := helmClient(3, "u", nil)
	want := "id helm-releases, ADDED web @ helm-releases, ADDED db @ helm-releases, id " + at + "?=15, MODIFIED web @ " + at + "?=16"
	for i, got := range []string{ids(), ids()} {
		if got != want {
			t.Errorf("server %d said %s\nwant %s", i+1, got, want)
		}
	}
}

// A stream cut while its watch sends what there is, before the watch's first bookmark, left the browser an id with no
// version: opened again, it sends every release and one resync, so a release the cut kept from the page is not missed.
func TestAHelmStreamCutBeforeItsWatchHasAPlaceStartsOverWhenOpenedAgain(t *testing.T) {
	quickHelmResume(t)
	api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
		if call.resourceVersion != "" {
			// a watch from the version of db, the last release the cut stream sent, would leave web as it was
			<-r.Context().Done()
			return
		}
		watchEvents(w, releaseEvent("ADDED", "team", "web", 1, "30"), releaseEvent("ADDED", "team", "db", 1, "10"))
		<-r.Context().Done()
	}}
	h, _ := liveHandler(t, api.serve, &atomic.Int32{})
	cut := framesUntil(t, helmFrames(t, h, nil, "", nil), isRelease("db"))
	id := cut[len(cut)-1].id
	if id != helmStreamID {
		t.Fatalf("the browser had %q before the watch's first bookmark, want %q", id, helmStreamID)
	}
	got := said(framesUntil(t, helmFrames(t, h, nil, "", http.Header{"Last-Event-Id": {id}}), isRelease("db")))
	if want := "id helm-releases, resync, ADDED web @ helm-releases, ADDED db @ helm-releases"; got != want {
		t.Errorf("opened again, the stream said %s\nwant %s", got, want)
	}
}

// The browser opening the stream again, here on another server built from the same registration, sends the id the
// stream wrote: the watch goes on from its version, so what changed since comes and the releases the page has are not
// sent again. The page followed the stream up to that id, so it reads nothing again, even when the stream's address
// says its list was read before it.
func TestAHelmStreamOpenedAgainWithItsIDGoesOnFromThereWithNothingSentAgain(t *testing.T) {
	quickHelmResume(t)
	for _, query := range []string{"", "resync=1"} {
		t.Run("query "+query, func(t *testing.T) {
			api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
				if call.resourceVersion == "" {
					watchEvents(w, releaseEvent("ADDED", "team", "web", 1, "10"), releaseEvent("ADDED", "team", "db", 1, "11"))
				} else {
					watchEvents(w, releaseEvent("DELETED", "team", "db", 1, "16"))
				}
				<-r.Context().Done()
			}}
			h := helmHandlerAt(t, api.serve, 3)
			at := helmClient(3, "u", nil)
			got := said(framesUntil(t, helmFrames(t, h, nil, query, http.Header{"Last-Event-Id": {at + "?=15"}}), isRelease("db")))
			if want := "id " + at + "?=15, DELETED db @ " + at + "?=16"; got != want {
				t.Errorf("the stream said %s\nwant %s", got, want)
			}
			if calls := api.made(); len(calls) != 1 || calls[0].resourceVersion != "15" {
				t.Errorf("watches %+v, want one from 15", calls)
			}
		})
	}
}

// One watch per namespace of a grant goes on from its own version. A namespace the id does not name (no place of it yet)
// starts from none, which sends what it has, and the id names no version until that watch has a place.
func TestEachNamespaceWatchOfAHelmStreamOpenedAgainGoesOnFromTheVersionItsIDNames(t *testing.T) {
	quickHelmResume(t)
	at := helmClient(0, "u", []string{"team-a", "team-b"})
	for _, c := range []struct {
		id, want string
		from     map[string]string
	}{
		{at + "?team-a=20&team-b=25", "id " + at + "?team-a=20&team-b=25, MODIFIED web @ " + at + "?team-a=21&team-b=25", map[string]string{"team-a": "20", "team-b": "25"}},
		{at + "?team-a=20", "id " + at + "?team-a=20, ADDED api @ helm-releases, MODIFIED web @ helm-releases", map[string]string{"team-a": "20", "team-b": ""}},
	} {
		t.Run(c.id, func(t *testing.T) {
			api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
				switch {
				case call.namespace == "team-b" && call.resourceVersion == "":
					watchEvents(w, releaseEvent("ADDED", "team-b", "api", 1, "12"))
				case call.namespace == "team-a":
					// after team-b's watch has answered, so the frames come in one order
					watchEvents(w)
					time.Sleep(100 * time.Millisecond)
					watchEvents(w, releaseEvent("MODIFIED", "team-a", "web", 2, "21"))
				default:
					watchEvents(w)
				}
				<-r.Context().Done()
			}}
			h, _ := liveHandler(t, api.serve, &atomic.Int32{})
			got := said(framesUntil(t, helmFrames(t, h, []string{"team-a", "team-b"}, "", http.Header{"Last-Event-Id": {c.id}}), func(f helmFrame) bool {
				return strings.Contains(f.data, `"MODIFIED"`)
			}))
			if got != c.want {
				t.Errorf("the stream said %s\nwant %s", got, c.want)
			}
			from := map[string]string{}
			for _, call := range api.made() {
				from[call.namespace] = call.resourceVersion
			}
			if len(from) != len(c.from) || from["team-a"] != c.from["team-a"] || from["team-b"] != c.from["team-b"] {
				t.Errorf("the watches went on from %v, want %v", from, c.from)
			}
		})
	}
}

// An id the stream cannot go on from starts as a stream with no id does: every release again, and one resync once the
// watch is on, so the page reads its list. Its version expired (the watch's answer, or an event of it), the watch from
// it could not start, it names another cluster or another registration of this one — whose API server may open a watch
// from a version it has not reached and send nothing until it does —, a namespace the grant no longer has, or a version
// no stream writes. Once the stream has let its versions go, the browser is told its id names none.
func TestAHelmStreamOpenedAgainWithAnIDItCannotGoOnFromSendsEverythingAndAsksForARead(t *testing.T) {
	quickHelmResume(t)
	const told = "id helm-releases, "
	at := helmClient(0, "u", nil)
	for _, c := range []struct {
		name, id, first, want string
		namespaces            []string
	}{
		{"expired, as the watch's answer", at + "?=15", "15", "id " + at + "?=15, " + told, nil},
		{"expired, as an event of the watch", at + "?=17", "17", "id " + at + "?=17, " + told, nil},
		{"the watch could not start", at + "?=18", "18", "id " + at + "?=18, " + told, nil},
		{"another registration of the cluster", helmClient(7, "u", nil) + "?=19", "", told, nil},
		{"another cluster", strings.Replace(at, "/c/", "/other/", 1) + "?=19", "", told, nil},
		{"another grant's namespace", helmClient(0, "u", []string{"team-a"}) + "?team-x=15", "", told, []string{"team-a"}},
		{"version 0, which is any", at + "?=0", "", told, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
				switch call.resourceVersion {
				case "15":
					statusAnswer(w, http.StatusGone, goneStatus)
					return
				case "17":
					watchEvents(w, expiredEvent)
					return
				case "18":
					statusAnswer(w, http.StatusServiceUnavailable, unavailableStatus)
					return
				case "19", "0":
					// as an API server answers a version it has not reached: the watch is on and sends nothing
					watchEvents(w)
					<-r.Context().Done()
					return
				}
				ns := call.namespace
				if ns == "" {
					ns = "team"
				}
				watchEvents(w, releaseEvent("ADDED", ns, "web", 1, "10"), releaseEvent("ADDED", ns, "db", 1, "11"))
				<-r.Context().Done()
			}}
			h, _ := liveHandler(t, api.serve, &atomic.Int32{})
			got := said(framesUntil(t, helmFrames(t, h, c.namespaces, "", http.Header{"Last-Event-Id": {c.id}}), isRelease("db")))
			if want := c.want + "resync, ADDED web @ helm-releases, ADDED db @ helm-releases"; got != want {
				t.Errorf("the stream said %s\nwant %s", got, want)
			}
			calls := api.made()
			if len(calls) == 0 || calls[0].resourceVersion != c.first || calls[len(calls)-1].resourceVersion != "" {
				t.Errorf("watches %+v, want the first from %q and the last from none", calls, c.first)
			}
		})
	}
}

// The browser sends the id back as a request header, which nginx holds to 8 KiB: an id past helmStreamIDMax, here of
// a grant of a hundred namespaces with long names, is written as one with no version, which a stream opened again
// reads as a reason to send everything and a resync. A grant of ten keeps its versions.
func TestAHelmStreamsIDPastItsLengthNamesNoVersion(t *testing.T) {
	quickHelmResume(t)
	quickHelmKeepalive(t)
	for _, c := range []struct {
		namespaces int
		versions   bool
	}{{10, true}, {100, false}} {
		t.Run(fmt.Sprint(c.namespaces, " namespaces"), func(t *testing.T) {
			grant := make([]string, c.namespaces)
			for i := range grant {
				grant[i] = fmt.Sprintf("team-%03d-%s", i, strings.Repeat("x", 50))
			}
			api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
				watchEvents(w, bookmarkEvent("1234567890"))
				if call.namespace == grant[0] {
					time.Sleep(300 * time.Millisecond)
					watchEvents(w, releaseEvent("MODIFIED", grant[0], "web", 2, "1234567891"))
				}
				<-r.Context().Done()
			}}
			h, _ := liveHandler(t, api.serve, &atomic.Int32{})
			got := framesUntil(t, helmFrames(t, h, grant, "", nil), isRelease("web"))
			id := got[len(got)-1].id
			if c.versions != strings.HasPrefix(id, helmClient(0, "u", grant)+"?") || len(id) > helmStreamIDMax {
				t.Errorf("the id after the release is %d bytes, %.60q…, want versions %v and at most %d bytes", len(id), id, c.versions, helmStreamIDMax)
			}
		})
	}
}

// Only an id the stream writes with versions is a place to go on from.
func TestParseHelmStreamIDReadsOnlyTheIDsTheStreamWrites(t *testing.T) {
	for _, p := range []*helmStreamPlace{
		{client: clientPlace("c", 3) + "/0123456789abcdef", from: helmWatchVersions{"": "15"}},
		{client: clientPlace("c", 3) + "/0123456789abcdef", from: helmWatchVersions{"team-a": "20", "team-b": "25"}},
		{client: clientPlace("a/b?c", 12) + "/0123456789abcdef", from: helmWatchVersions{"a": "1"}},
	} {
		client, got, ok := parseHelmStreamID(p.id())
		if !ok || client != p.client || len(got) != len(p.from) {
			t.Errorf("%q read as %q %v %v, want %q %v", p.id(), client, got, ok, p.client, p.from)
		}
		for ns, version := range p.from {
			if got[ns] != version {
				t.Errorf("%q read %q as %q, want %q", p.id(), ns, got[ns], version)
			}
		}
	}
	for _, id := range []string{
		"", "helm-releases", "helm-releases?=15", "helm-releases/?=15", "helm-releases/c/3", "helm-releases/c/3?",
		"helm-releases/c/3?=", "helm-releases/c/3?=0", "helm-releases/c/3?=015", "helm-releases/c/3?=1a", "helm-releases/c/3?a=1&a=2",
		"helm-releases/c/3?a=1;b=2", "other/c/3?=15", "2026-11-17T00:00:00.000000000Z#1",
	} {
		if client, got, ok := parseHelmStreamID(id); ok {
			t.Errorf("%q read as %q %v, want no place to go on from", id, client, got)
		}
	}
}

// The rows on a page came of what its person could see. A stream the browser opens again as someone else (a sign-in in
// another tab), or for the same person with a narrower grant — whose id may name only namespaces the grant still has —
// starts over with a resync, so rows the reader may no longer see go. The same person with the same grant goes on.
func TestAHelmStreamOpenedAgainByAnotherPersonOrGrantStartsOver(t *testing.T) {
	quickHelmResume(t)
	for _, c := range []struct {
		name, user string
		before     []string // the grant the id was written for
		now        []string
		want       string
	}{
		{"the same person and grant", "u", []string{"team-a", "team-b"}, []string{"team-a", "team-b"}, "id {at}?team-a=15, MODIFIED web @ helm-releases"},
		{"another person", "v", []string{"team-a", "team-b"}, []string{"team-a", "team-b"}, "id helm-releases, resync, ADDED web @ helm-releases"},
		{"a narrower grant", "u", []string{"team-a", "team-b"}, []string{"team-a"}, "id helm-releases, resync, ADDED web @ helm-releases"},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := &scriptedSecretWatches{answer: func(w http.ResponseWriter, r *http.Request, call secretWatchCall, n int) {
				switch {
				case call.namespace == "team-a" && call.resourceVersion == "15":
					watchEvents(w, releaseEvent("MODIFIED", "team-a", "web", 2, "16"))
				case call.namespace == "team-a":
					watchEvents(w, releaseEvent("ADDED", "team-a", "web", 1, "10"))
				default:
					watchEvents(w)
				}
				<-r.Context().Done()
			}}
			h, _ := liveHandler(t, api.serve, &atomic.Int32{})
			id := helmClient(0, "u", c.before) + "?team-a=15"
			got := said(framesUntil(t, helmFramesAs(t, h, c.user, c.now, "", http.Header{"Last-Event-Id": {id}}), isRelease("web")))
			if want := strings.ReplaceAll(c.want, "{at}", helmClient(0, "u", c.before)); got != want {
				t.Errorf("the stream said %s\nwant %s", got, want)
			}
		})
	}
}

// The person's tag is a short hash, the same for the same person and grant on any server, holding no name; another
// person, role or grant has another.
func TestPersonTagNamesThePersonAndGrantWithNoName(t *testing.T) {
	as := func(p auth.TokenPayload) string {
		return personTag(cluster.WithID(auth.WithPayload(context.Background(), p), "c"), "c")
	}
	base := auth.TokenPayload{UserID: "user-4711", Roles: map[string]string{"c": "Read"}, Namespaces: map[string][]string{"c": {"team-b", "team-a"}}}
	same := base
	same.Namespaces = map[string][]string{"c": {"team-a", "team-b"}}
	same.AuthTime = 99
	other := base
	other.UserID = "user-4712"
	role := base
	role.Roles = map[string]string{"c": "Write"}
	narrower := base
	narrower.Namespaces = map[string][]string{"c": {"team-a"}}
	whole := base
	whole.Namespaces = nil

	tag := as(base)
	if len(tag) != 16 || strings.Trim(tag, "0123456789abcdef") != "" || strings.Contains(tag, "4711") {
		t.Errorf("tag %q, want 16 hex digits and no name", tag)
	}
	if got := as(same); got != tag {
		t.Errorf("the same person and grant, in another order and another sign-in: %q, want %q", got, tag)
	}
	for name, p := range map[string]auth.TokenPayload{"another person": other, "another role": role, "a narrower grant": narrower, "the whole cluster": whole} {
		if as(p) == tag {
			t.Errorf("%s has the same tag %q", name, tag)
		}
	}
}
