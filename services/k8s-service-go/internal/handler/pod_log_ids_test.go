package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// kubeletLog serves a pod's log as the kubelet does for follow=true&timestamps=true: tailLines first, then sinceTime
// (whole seconds), then it holds the stream. It keeps each request's query.
type kubeletLog struct {
	mu      sync.Mutex
	lines   []string
	queries []url.Values
}

func (k *kubeletLog) add(lines ...string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.lines = append(k.lines, lines...)
}

func (k *kubeletLog) asked() []url.Values {
	k.mu.Lock()
	defer k.mu.Unlock()
	return slices.Clone(k.queries)
}

func (k *kubeletLog) serve(w http.ResponseWriter, r *http.Request) {
	if !strings.HasSuffix(r.URL.Path, "/log") {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	k.mu.Lock()
	k.queries = append(k.queries, q)
	lines := slices.Clone(k.lines)
	k.mu.Unlock()
	if n, err := strconv.Atoi(q.Get("tailLines")); err == nil && n < len(lines) {
		lines = lines[len(lines)-n:]
	}
	if s := q.Get("sinceTime"); s != "" {
		since, err := time.Parse(time.RFC3339, s)
		if err != nil {
			http.Error(w, "bad sinceTime", http.StatusBadRequest)
			return
		}
		var kept []string
		for _, l := range lines {
			stamp, _, _ := strings.Cut(l, " ")
			if at, err := time.Parse(time.RFC3339Nano, stamp); err != nil || !at.Before(since) {
				kept = append(kept, l)
			}
		}
		lines = kept
	}
	for _, l := range lines {
		_, _ = fmt.Fprintln(w, l)
	}
	w.(http.Flusher).Flush()
	<-r.Context().Done()
}

// logFrame is one message of the followed log's stream: its id and its data.
type logFrame struct{ id, data string }

// logFrames opens the followed log, sending lastEventID as a browser does when it reconnects, and returns the first n
// messages, then whatever else comes within a moment.
func logFrames(t *testing.T, serve http.HandlerFunc, target, lastEventID string, n int) []logFrame {
	t.Helper()
	srv := httptest.NewServer(serve)
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+target, nil)
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	frames := make(chan logFrame, 64)
	go func() {
		defer close(frames)
		sc := bufio.NewScanner(resp.Body)
		var f logFrame
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "id: "):
				f.id = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "data: "):
				f.data = strings.TrimPrefix(line, "data: ")
			case line == "" && f.data != "":
				frames <- f
				f = logFrame{}
			}
		}
	}()
	var got []logFrame
	wait := time.After(5 * time.Second)
	for len(got) < n {
		select {
		case f, ok := <-frames:
			if !ok {
				return got
			}
			got = append(got, f)
		case <-wait:
			return got
		}
	}
	extra := time.After(200 * time.Millisecond)
	for {
		select {
		case f, ok := <-frames:
			if !ok {
				return got
			}
			got = append(got, f)
		case <-extra:
			return got
		}
	}
}

func logReadRows(t *testing.T, store *lockedAudit) []map[string]any {
	t.Helper()
	store.mu.Lock()
	defer store.mu.Unlock()
	var out []map[string]any
	for _, r := range store.rows {
		if r.Action != "k8s.pod.logs.read" {
			continue
		}
		var after map[string]any
		_ = json.Unmarshal(r.After, &after)
		out = append(out, after)
	}
	return out
}

// A followed log that reconnects (the browser sends the id of the last line it got) goes on with the lines after
// it: none it already has, none written while it was away lost, lines stamped alike told apart by their place.
func TestAFollowedLogThatReconnectsGoesOnAfterTheLastLineItGot(t *testing.T) {
	kl := &kubeletLog{lines: []string{
		"2026-11-09T05:58:04.900000000Z zero",
		"2026-11-09T05:58:05.100000000Z one",
		"2026-11-09T05:58:05.300000000Z two",
		"2026-11-09T05:58:05.300000000Z two-b",
	}}
	var version atomic.Int32
	h, store := liveHandler(t, kl.serve, &version)
	serve := func(w http.ResponseWriter, r *http.Request) {
		h.PodLogsSSE(w, withLogFileContext(r, "apps", "resource.pod.read"))
	}

	first := logFrames(t, serve, "/x?container=app&tail_lines=3", "", 3)
	if want := []logFrame{
		{"2026-11-09T05:58:05.100000000Z#1", "2026-11-09T05:58:05.100000000Z one"},
		{"2026-11-09T05:58:05.300000000Z#1", "2026-11-09T05:58:05.300000000Z two"},
		{"2026-11-09T05:58:05.300000000Z#2", "2026-11-09T05:58:05.300000000Z two-b"},
	}; !slices.Equal(first, want) {
		t.Errorf("first connection = %q, want %q", first, want)
	}

	// The connection drops; meanwhile the pod prints on, one line stamped as the last one the browser has.
	kl.add("2026-11-09T05:58:05.300000000Z two-c", "2026-11-09T05:58:06.200000000Z three")
	again := logFrames(t, serve, "/x?container=app&tail_lines=3", "2026-11-09T05:58:05.300000000Z#2", 2)
	if want := []logFrame{
		{"2026-11-09T05:58:05.300000000Z#3", "2026-11-09T05:58:05.300000000Z two-c"},
		{"2026-11-09T05:58:06.200000000Z#1", "2026-11-09T05:58:06.200000000Z three"},
	}; !slices.Equal(again, want) {
		t.Errorf("after the reconnect = %q, want %q", again, want)
	}

	asked := kl.asked()
	if len(asked) != 2 {
		t.Fatalf("log reads = %d, want 2", len(asked))
	}
	if got := [2]string{asked[0].Get("tailLines"), asked[0].Get("sinceTime")}; got != [2]string{"3", ""} {
		t.Errorf("first read tailLines, sinceTime = %q, want the tail", got)
	}
	if got := [2]string{asked[1].Get("tailLines"), asked[1].Get("sinceTime")}; got != [2]string{"", "2026-11-09T05:58:05Z"} {
		t.Errorf("read after the reconnect tailLines, sinceTime = %q, want no tail, since the second of the last line", got)
	}

	rows := logReadRows(t, store)
	if len(rows) != 2 {
		t.Fatalf("k8s.pod.logs.read rows = %d, want one per connection", len(rows))
	}
	if want := map[string]any{"container": "app", "follow": true, "tail_lines": float64(3)}; fmt.Sprint(rows[0]) != fmt.Sprint(want) {
		t.Errorf("first row after = %v, want %v", rows[0], want)
	}
	if want := map[string]any{"container": "app", "follow": true, "resume_from": "2026-11-09T05:58:05.300000000Z#2"}; fmt.Sprint(rows[1]) != fmt.Sprint(want) {
		t.Errorf("row of the reconnect after = %v, want %v: it read the lines after that one, not the last 100", rows[1], want)
	}
}

// An id the server did not write is not a place to go on from: the stream starts with the tail as a new one does.
func TestAFollowedLogGivenAnIdItDidNotWriteStartsWithTheTail(t *testing.T) {
	kl := &kubeletLog{lines: []string{"2026-11-09T05:58:05.100000000Z one", "2026-11-09T05:58:05.300000000Z two"}}
	var version atomic.Int32
	h, store := liveHandler(t, kl.serve, &version)
	serve := func(w http.ResponseWriter, r *http.Request) {
		h.PodLogsSSE(w, withLogFileContext(r, "apps", "resource.pod.read"))
	}
	for _, id := range []string{"x", "2026-11-09T05:58:05Z", "2026-11-09T05:58:05Z#0", "2026-11-09T05:58:05Z#-1", "yesterday#1"} {
		got := logFrames(t, serve, "/x?container=app&tail_lines=5", id, 2)
		if want := []logFrame{
			{"2026-11-09T05:58:05.100000000Z#1", "2026-11-09T05:58:05.100000000Z one"},
			{"2026-11-09T05:58:05.300000000Z#1", "2026-11-09T05:58:05.300000000Z two"},
		}; !slices.Equal(got, want) {
			t.Errorf("Last-Event-ID %q: frames = %q, want %q", id, got, want)
		}
	}
	for i, q := range kl.asked() {
		if q.Get("tailLines") != "5" || q.Get("sinceTime") != "" {
			t.Errorf("read %d tailLines, sinceTime = %q, %q, want the tail", i, q.Get("tailLines"), q.Get("sinceTime"))
		}
	}
	for i, row := range logReadRows(t, store) {
		if _, ok := row["resume_from"]; ok || row["tail_lines"] != float64(5) {
			t.Errorf("row %d after = %v, want the tail", i, row)
		}
	}
}

// Ids rise in the order the lines came, also when a line is stamped no later than the one before it (stdout and
// stderr written a moment apart) or carries no stamp, so the page never takes a new line for one it has.
func TestFollowedLogIdsRiseInTheOrderTheLinesCame(t *testing.T) {
	kl := &kubeletLog{lines: []string{
		"2026-11-09T05:58:05.300000000Z out",
		"2026-11-09T05:58:05.200000000Z err",
		"no stamp",
		"2026-11-09T05:58:05.400000000Z later",
	}}
	var version atomic.Int32
	h, _ := liveHandler(t, kl.serve, &version)
	got := logFrames(t, func(w http.ResponseWriter, r *http.Request) {
		h.PodLogsSSE(w, withLogFileContext(r, "apps", "resource.pod.read"))
	}, "/x?container=app", "", 4)
	want := []logFrame{
		{"2026-11-09T05:58:05.300000000Z#1", "2026-11-09T05:58:05.300000000Z out"},
		{"2026-11-09T05:58:05.300000000Z#2", "2026-11-09T05:58:05.200000000Z err"},
		{"2026-11-09T05:58:05.300000000Z#3", "no stamp"},
		{"2026-11-09T05:58:05.400000000Z#1", "2026-11-09T05:58:05.400000000Z later"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("frames = %q, want %q", got, want)
	}
}
