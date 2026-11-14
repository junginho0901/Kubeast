package handler

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
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
