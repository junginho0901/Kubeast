package handler

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// helmWatchAPI holds every Secret watch open until its request ends and counts them: open now and at most, and how many
// were starting at once (the first answer held for a moment).
type helmWatchAPI struct {
	mu                                     sync.Mutex
	open, mostOpen, starting, mostStarting int
}

func (a *helmWatchAPI) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("watch") != "true" || !strings.HasSuffix(r.URL.Path, "/secrets") {
		http.NotFound(w, r)
		return
	}
	a.mu.Lock()
	a.open++
	a.starting++
	a.mostOpen, a.mostStarting = max(a.mostOpen, a.open), max(a.mostStarting, a.starting)
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.open--
		a.mu.Unlock()
	}()
	time.Sleep(50 * time.Millisecond)
	a.mu.Lock()
	a.starting--
	a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.(http.Flusher).Flush()
	<-r.Context().Done()
}

func (a *helmWatchAPI) counts() (open, mostOpen, mostStarting int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.open, a.mostOpen, a.mostStarting
}

// helmStream is one page's Helm releases stream: the named events it got, and the end of it.
type helmStream struct {
	told, following atomic.Int32
	stop            context.CancelFunc
}

func openHelmStream(t *testing.T, h *Handler, user string, namespaces []string) *helmStream {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := cluster.WithID(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: user, Perms: auth.PermissionMatrix{"*": {"*"}}, Namespaces: map[string][]string{"c": namespaces}}), "c")
		h.WatchHelmReleases(w, r.WithContext(ctx))
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	s := &helmStream{stop: cancel}
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		name := ""
		for sc.Scan() {
			switch line := sc.Text(); {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				if name == "error" && strings.Contains(line, `"reason":"limit"`) {
					s.told.Add(1)
				}
				if name == "following" {
					s.following.Add(1)
				}
				name = ""
			}
		}
	}()
	return s
}

// The Helm releases' stream keeps to the sockets' limits: its watches, one per namespace of a grant limited to them,
// count against the server's live watches and start through the cluster's places. A stream that does not fit is told
// as a socket's list is, asks again later, and says it follows once it does.
func TestHelmStreamsKeepToTheServersWatchLimitAndStartPlaces(t *testing.T) {
	retry := helmLimitRetry
	helmLimitRetry = func() time.Duration { return 20 * time.Millisecond }
	defer func() { helmLimitRetry = retry }()

	api := &helmWatchAPI{}
	h, _ := liveHandler(t, api.serve, &atomic.Int32{})
	mux := ws.NewMultiplexer(nil)
	mux.MaxSubscriptions, mux.MaxWatchStarts = 30, 4
	h.SetWatchLimits(mux)
	streams := make([]*helmStream, 8)
	for i := range streams {
		namespaces := make([]string, 5)
		for j := range namespaces {
			namespaces[j] = fmt.Sprintf("team-%d-%d", i, j)
		}
		streams[i] = openHelmStream(t, h, fmt.Sprintf("u%d", i), namespaces)
	}
	toldStreams := func() (n int) {
		for _, s := range streams {
			if s.told.Load() > 0 {
				n++
			}
		}
		return n
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if open, _, _ := api.counts(); open == 30 && toldStreams() == 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)
	open, mostOpen, mostStarting := api.counts()
	t.Logf("8 streams of 5 namespaces each: %d Secret watches open (at most %d), at most %d starting at once, %d streams told the limit", open, mostOpen, mostStarting, toldStreams())
	if mostOpen > 30 {
		t.Errorf("%d Helm Secret watches open, past the server's limit of live watches (30)", mostOpen)
	}
	if mostStarting > 4 {
		t.Errorf("%d Helm Secret watches starting at once, past the cluster's places for starting a watch (4)", mostStarting)
	}
	if open != 30 || toldStreams() != 2 || mux.SubscriptionCount() != 30 {
		t.Errorf("%d open, %d streams told, %d counted, want 30, 2 and 30", open, toldStreams(), mux.SubscriptionCount())
	}

	// a stream that ends gives its watches back, and one that was told takes them and says it follows
	for _, s := range streams {
		if s.told.Load() == 0 {
			s.stop()
			break
		}
	}
	deadline = time.Now().Add(10 * time.Second)
	followed := func() (n int) {
		for _, s := range streams {
			n += int(s.following.Load())
		}
		return n
	}
	for time.Now().Before(deadline) && followed() == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if got := followed(); got != 1 {
		t.Errorf("%d told streams said they follow again after one stream ended, want 1", got)
	}
	if !eventuallyTrue(5*time.Second, func() bool { open, _, _ := api.counts(); return open == 30 }) {
		open, _, _ := api.counts()
		t.Errorf("%d Secret watches open after the change of hands, want 30", open)
	}
}

func eventuallyTrue(d time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}
