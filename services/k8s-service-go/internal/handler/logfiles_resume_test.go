package handler

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/probe"
)

// sseFields reads a stream's id, event and data lines in order: an id-only block is the place it marks.
func sseFields(t *testing.T, srvURL, target, lastEventID string) (<-chan sseEvent, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srvURL+target, nil)
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		cancel()
		t.Fatalf("status %d", resp.StatusCode)
	}
	out := make(chan sseEvent, 64)
	go func() {
		defer resp.Body.Close()
		defer close(out)
		sc := bufio.NewScanner(resp.Body)
		name := ""
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "id: "):
				out <- sseEvent{"id", strings.TrimPrefix(line, "id: ")}
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				out <- sseEvent{name, strings.TrimPrefix(line, "data: ")}
				name = ""
			}
		}
	}()
	return out, cancel
}

func expectEvents(t *testing.T, events <-chan sseEvent, step string, want ...sseEvent) {
	t.Helper()
	for _, w := range want {
		select {
		case got, ok := <-events:
			if !ok || got != w {
				t.Fatalf("%s: got %+v (open %v), want %+v", step, got, ok, w)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("%s: timed out waiting for %+v", step, w)
		}
	}
}

// A followed file marks where its lines end; the browser that connects again with that mark (a server that left, a
// dropped connection) gets the lines after it, none twice, and the row says where it went on from.
func TestLogFileStreamGoesOnAfterTheBrowsersLastLine(t *testing.T) {
	orig := logFilePollInterval
	logFilePollInterval = 5 * time.Millisecond
	defer func() { logFilePollInterval = orig }()

	file := &fakeFile{inode: "11", data: "l1\nl2\nl3\n"}
	h, store, _ := logFileHandler(t, true, file.run)
	var running sync.WaitGroup
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		running.Add(1)
		defer running.Done()
		h.LogFileStream(w, withLogFileContext(r, "apps", "resource.pod.logfile"))
	}))
	defer srv.Close()
	const target = "/x?container=app&path=/var/log/app/app.log&lines=1"

	first, stop := sseFields(t, srv.URL, target, "")
	expectEvents(t, first, "the last line, then where it ends", sseEvent{"", "l3"}, sseEvent{"id", "11:9"})
	file.update(func(f *fakeFile) { f.data += "l4\npar" })
	expectEvents(t, first, "a new line; the partial one is not counted", sseEvent{"", "l4"}, sseEvent{"id", "11:12"})
	stop()

	file.update(func(f *fakeFile) { f.data += "tial\nl5\n" })
	again, stopAgain := sseFields(t, srv.URL, target, "11:12")
	expectEvents(t, again, "after the mark, not the last line again", sseEvent{"", "partial"}, sseEvent{"", "l5"}, sseEvent{"id", "11:23"})
	stopAgain()

	other, stopOther := sseFields(t, srv.URL, target, "10:12")
	expectEvents(t, other, "another file under the name: its last lines, said so",
		sseEvent{"notice", "the file was replaced or truncated while reconnecting; showing its last lines"}, sseEvent{"", "l5"}, sseEvent{"id", "11:23"})
	stopOther()

	done := make(chan struct{})
	go func() { running.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("a stream kept running after its client left")
	}
	if len(store.rows) != 3 {
		t.Fatalf("rows = %d, want one per connection", len(store.rows))
	}
	if after := string(store.rows[0].After); strings.Contains(after, "resume_from") {
		t.Fatalf("the first connection's row = %s", after)
	}
	for i, want := range []string{`"resume_from":"11:12"`, `"resume_from":"10:12"`} {
		if after := string(store.rows[i+1].After); !strings.Contains(after, want) {
			t.Fatalf("row %d = %s, want %s", i+1, after, want)
		}
	}
}

// A server that leaves while a poll's command runs cuts that command with the stream's context: the stream ends with
// the reconnection time alone, no error and no end, so the browser connects again and goes on from its mark.
func TestAFollowedLogFileTheServerLeavesDuringACommandAsksTheBrowserBack(t *testing.T) {
	orig := logFilePollInterval
	logFilePollInterval = 5 * time.Millisecond
	defer func() { logFilePollInterval = orig }()

	file := &fakeFile{inode: "11", data: "l1\n"}
	h, _, _ := logFileHandler(t, true, file.run)
	store := &lockedAudit{}
	h.auditStore = store
	p := probe.New()
	h.SetLeaving(p)
	var holdNext atomic.Bool
	held := make(chan struct{})
	var once sync.Once
	fake := h.logFileExec
	h.logFileExec = func(ctx context.Context, ns, pod, container string, argv []string, stdout, stderr io.Writer) error {
		if holdNext.Load() {
			once.Do(func() { close(held) })
			<-ctx.Done()
			return ctx.Err() // what the exec stream answers when its context ends: "context canceled"
		}
		return fake(ctx, ns, pod, container, argv, stdout, stderr)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.LogFileStream(w, withLogFileContext(r, "apps", "resource.pod.logfile"))
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/x?container=app&path=/var/log/app/app.log&lines=1", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	lines := make(chan string, 64)
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
	}()
	for marked := false; !marked; {
		select {
		case l, ok := <-lines:
			if !ok {
				t.Fatal("the stream ended before its first mark")
			}
			marked = l == "id: 11:3"
		case <-time.After(3 * time.Second):
			t.Fatal("no mark after the first line")
		}
	}

	holdNext.Store(true)
	select {
	case <-held:
	case <-time.After(3 * time.Second):
		t.Fatal("no poll command ran")
	}
	p.Leave()

	var rest []string
	for open := true; open; {
		select {
		case l, ok := <-lines:
			if ok {
				rest = append(rest, l)
			}
			open = ok
		case <-time.After(3 * time.Second):
			t.Fatalf("the stream did not end when the server left: %q", rest)
		}
	}
	got := strings.Join(rest, "\n")
	if !strings.Contains(got, "retry: 1000") || strings.Contains(got, "event: error") || strings.Contains(got, "event: end") {
		t.Fatalf("after the server left the stream wrote %q, want the reconnection time alone", got)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.rows) != 1 || store.rows[0].Action != auditLogFileRead {
		t.Fatalf("rows = %+v, want the read's row alone (a followed log the server left has no end row)", store.rows)
	}
}

func TestParseLogFileMarkTakesOnlyWhatTheStreamWrote(t *testing.T) {
	for in, ok := range map[string]bool{
		"11:9": true, "123456:0": true,
		"": false, ":9": false, "11:": false, "11:-1": false, "a1:9": false, "11:9x": false, "1 1:9": false,
	} {
		if _, got := parseLogFileMark(in); got != ok {
			t.Errorf("parseLogFileMark(%q) ok = %v, want %v", in, got, ok)
		}
	}
}
