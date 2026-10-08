package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	utilexec "k8s.io/client-go/util/exec"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logfiles"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// fakeCommand answers one argv: what it prints and how it ends.
type fakeCommand struct {
	stdout, stderr string
	err            error
}

func logFileHandler(t *testing.T, enabled bool, run func(argv []string) fakeCommand) (*Handler, *memAudit, *[][]string) {
	t.Helper()
	store := &memAudit{}
	var calls [][]string
	h := &Handler{auditStore: store, cfg: config.Config{
		LogFilesEnabled: enabled, LogFilesNamespaces: []string{"apps"}, LogFilesMaxLines: 500,
	}}
	ps, err := logfiles.Parse([]string{"/var/log/app/*.log", "/srv/log/production.log"})
	if err != nil {
		t.Fatal(err)
	}
	h.SetLogFilePatterns(ps)
	h.logFileExec = func(_ context.Context, ns, pod, container string, argv []string, stdout, stderr io.Writer) error {
		if ns == "" || pod == "" || container != "app" {
			return fmt.Errorf("unexpected target %s/%s/%s", ns, pod, container)
		}
		calls = append(calls, argv)
		c := run(argv)
		_, _ = io.WriteString(stdout, c.stdout)
		_, _ = io.WriteString(stderr, c.stderr)
		return c.err
	}
	return h, store, &calls
}

func logFileRequest(target, namespace string, perms ...string) *http.Request {
	return withLogFileContext(httptest.NewRequest(http.MethodGet, target, nil), namespace, perms...)
}

// withLogFileContext adds what the middleware would: the caller, the cluster and the route parameters.
func withLogFileContext(r *http.Request, namespace string, perms ...string) *http.Request {
	ctx := context.WithValue(r.Context(), auth.TokenPayloadContextKey(), auth.TokenPayload{UserID: "u1", Email: "dev@example.com", Perms: auth.PermissionMatrix{"*": perms}})
	ctx = cluster.WithID(ctx, "self")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("namespace", namespace)
	rc.URLParams.Add("name", "web-0")
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rc)
	return r.WithContext(ctx)
}

func decodeLogFileError(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct{ Detail, Reason string }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body %q: %v", w.Body, err)
	}
	return body.Reason
}

func TestLogFilesGates(t *testing.T) {
	never := func([]string) fakeCommand { return fakeCommand{err: errors.New("must not run")} }
	routes := map[string]func(*Handler) http.HandlerFunc{
		"list":    func(h *Handler) http.HandlerFunc { return h.ListLogFiles },
		"content": func(h *Handler) http.HandlerFunc { return h.GetLogFileContent },
		"stream":  func(h *Handler) http.HandlerFunc { return h.LogFileStream },
	}
	target := "/x?container=app&path=/var/log/app/app.log"
	for name, route := range routes {
		h, store, calls := logFileHandler(t, false, never)
		w := httptest.NewRecorder()
		route(h)(w, logFileRequest(target, "apps", "*"))
		if w.Code != http.StatusNotFound || decodeLogFileError(t, w) != "disabled" {
			t.Errorf("%s disabled: %d %s", name, w.Code, w.Body)
		}
		h, store, calls = logFileHandler(t, true, never)
		w = httptest.NewRecorder()
		route(h)(w, logFileRequest(target, "apps", "resource.pod.read", "resource.pod.exec"))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s without resource.pod.logfile: %d", name, w.Code)
		}
		if len(store.rows) != 0 || len(*calls) != 0 {
			t.Errorf("%s: refused before the gate but rows=%d calls=%v", name, len(store.rows), *calls)
		}
		w = httptest.NewRecorder()
		route(h)(w, logFileRequest(target, "kube-system", "resource.pod.logfile"))
		if w.Code != http.StatusForbidden || decodeLogFileError(t, w) != "namespace" {
			t.Errorf("%s outside the namespaces: %d %s", name, w.Code, w.Body)
		}
		if len(*calls) != 0 {
			t.Errorf("%s ran a command outside the namespaces: %v", name, *calls)
		}
		if name == "list" && len(store.rows) != 0 {
			t.Errorf("list wrote audit rows: %+v", store.rows)
		}
		if name != "list" && (len(store.rows) != 1 || store.rows[0].Result != audit.ResultFailure || store.rows[0].Action != "k8s.pod.logfile.read") {
			t.Errorf("%s namespace refusal audit = %+v", name, store.rows)
		}
	}
}

func TestLogFileContentRejectsPaths(t *testing.T) {
	h, store, calls := logFileHandler(t, true, func([]string) fakeCommand { return fakeCommand{err: errors.New("must not run")} })
	for _, q := range []string{
		"path=/etc/passwd",
		"path=/var/log/app/../../../etc/passwd",
		"path=/var/log/app/sub/a.log",
		"path=/var/log/app//a.log",
		"path=",
		"path=/var/log/app/a.log&lines=abc",
		"path=/var/log/app/a.log&lines=0",
		"path=/var/log/app/a.log&lines=-5",
	} {
		w := httptest.NewRecorder()
		h.GetLogFileContent(w, logFileRequest("/x?container=app&"+q, "apps", "resource.pod.logfile"))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", q, w.Code, w.Body)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("a rejected path ran a command: %v", *calls)
	}
	for _, row := range store.rows {
		if row.Result != audit.ResultFailure {
			t.Errorf("rejected read audited as %s", row.Result)
		}
	}
	if len(store.rows) != 8 {
		t.Errorf("rejected reads: %d audit rows, want 8", len(store.rows))
	}
}

func TestLogFileContent(t *testing.T) {
	h, store, calls := logFileHandler(t, true, func(argv []string) fakeCommand {
		return fakeCommand{stdout: "line 1\nline 2\n"}
	})
	w := httptest.NewRecorder()
	h.GetLogFileContent(w, logFileRequest("/x?container=app&path=/var/log/app/app.log&lines=9999", "apps", "resource.pod.logfile"))
	if w.Code != http.StatusOK {
		t.Fatalf("content: %d %s", w.Code, w.Body)
	}
	if want := [][]string{{"tail", "-n", "500", "--", "/var/log/app/app.log"}}; !reflect.DeepEqual(*calls, want) {
		t.Fatalf("argv = %v, want %v (lines capped at the maximum)", *calls, want)
	}
	var body struct {
		Content   string
		Lines     int
		Path      string
		Truncated bool
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body.Content != "line 1\nline 2\n" || body.Lines != 500 || body.Path != "/var/log/app/app.log" || body.Truncated {
		t.Fatalf("body = %+v", body)
	}
	if len(store.rows) != 1 {
		t.Fatalf("audit rows = %+v", store.rows)
	}
	row := store.rows[0]
	if row.Action != "k8s.pod.logfile.read" || row.TargetType != "pod" || row.TargetID != "web-0" || row.Namespace != "apps" || row.Cluster != "self" || row.Result == audit.ResultFailure {
		t.Fatalf("audit row = %+v", row)
	}
	var after map[string]interface{}
	_ = json.Unmarshal(row.After, &after)
	if after["path"] != "/var/log/app/app.log" || after["container"] != "app" || after["lines"] != float64(500) || after["follow"] != false {
		t.Fatalf("audit after = %s", row.After)
	}
}

func TestLogFileCommandErrors(t *testing.T) {
	forbidden := apierrors.NewForbidden(schema.GroupResource{Resource: "pods/exec"}, "web-0", errors.New("cannot create"))
	cases := []struct {
		name   string
		cmd    fakeCommand
		status int
		reason string
	}{
		{"missing file", fakeCommand{stderr: "tail: can't open '/var/log/app/app.log': No such file or directory\n", err: utilexec.CodeExitError{Err: errors.New("exit 1"), Code: 1}}, http.StatusNotFound, "no_file"},
		{"unreadable", fakeCommand{stderr: "tail: cannot open '/var/log/app/app.log' for reading: Permission denied\n", err: utilexec.CodeExitError{Err: errors.New("exit 1"), Code: 1}}, http.StatusUnprocessableEntity, "unreadable"},
		{"no tail (exit code)", fakeCommand{err: utilexec.CodeExitError{Err: errors.New("exit 127"), Code: 127}}, http.StatusUnprocessableEntity, "tool_missing"},
		{"no tail (runtime)", fakeCommand{err: errors.New(`OCI runtime exec failed: exec failed: unable to start container process: exec: "tail": executable file not found in $PATH: unknown`)}, http.StatusUnprocessableEntity, "tool_missing"},
		{"exec forbidden", fakeCommand{err: forbidden}, http.StatusForbidden, "forbidden"},
		{"pod gone", fakeCommand{err: apierrors.NewNotFound(schema.GroupResource{Resource: "pods"}, "web-0")}, http.StatusNotFound, "not_found"},
	}
	for _, c := range cases {
		h, store, _ := logFileHandler(t, true, func([]string) fakeCommand { return c.cmd })
		w := httptest.NewRecorder()
		h.GetLogFileContent(w, logFileRequest("/x?container=app&path=/var/log/app/app.log", "apps", "resource.pod.logfile"))
		if w.Code != c.status || decodeLogFileError(t, w) != c.reason {
			t.Errorf("%s: %d %s, want %d %s", c.name, w.Code, w.Body, c.status, c.reason)
		}
		if len(store.rows) != 1 || store.rows[0].Result != audit.ResultFailure || store.rows[0].Error == "" {
			t.Errorf("%s audit = %+v", c.name, store.rows)
		}
	}
}

func TestListLogFiles(t *testing.T) {
	h, store, calls := logFileHandler(t, true, func(argv []string) fakeCommand {
		switch argv[len(argv)-1] {
		case "/var/log/app":
			return fakeCommand{stdout: "b.log\na.log\narchive/\nnotes.txt\n"}
		case "/srv/log":
			return fakeCommand{stderr: "ls: /srv/log: No such file or directory\n", err: utilexec.CodeExitError{Err: errors.New("exit 1"), Code: 1}}
		}
		return fakeCommand{err: errors.New("unexpected")}
	})
	w := httptest.NewRecorder()
	h.ListLogFiles(w, logFileRequest("/x?container=app", "apps", "resource.pod.logfile"))
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	if want := [][]string{{"ls", "-1p", "--", "/srv/log"}, {"ls", "-1p", "--", "/var/log/app"}}; !reflect.DeepEqual(*calls, want) {
		t.Fatalf("argv = %v, want %v", *calls, want)
	}
	var body struct {
		Files    []struct{ Path string }
		Patterns []string
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if len(body.Files) != 2 || body.Files[0].Path != "/var/log/app/a.log" || body.Files[1].Path != "/var/log/app/b.log" || len(body.Patterns) != 2 {
		t.Fatalf("body = %s", w.Body)
	}
	if len(store.rows) != 0 {
		t.Fatalf("listing wrote audit rows: %+v", store.rows)
	}

	h, _, _ = logFileHandler(t, true, func([]string) fakeCommand {
		return fakeCommand{err: utilexec.CodeExitError{Err: errors.New("exit 127"), Code: 127}}
	})
	w = httptest.NewRecorder()
	h.ListLogFiles(w, logFileRequest("/x?container=app", "apps", "resource.pod.logfile"))
	if w.Code != http.StatusUnprocessableEntity || decodeLogFileError(t, w) != "tool_missing" {
		t.Fatalf("no ls: %d %s", w.Code, w.Body)
	}
}

// fakeFile is a log file inside the fake container: it answers ls -lindL and
// tail -c +N the way busybox does, and the test grows, truncates or removes it.
type fakeFile struct {
	mu    sync.Mutex
	inode string
	data  string
	gone  bool
	tails int // tail -c +N calls
}

func (f *fakeFile) update(fn func(f *fakeFile)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeFile) run(argv []string) fakeCommand {
	f.mu.Lock()
	defer f.mu.Unlock()
	missing := fakeCommand{stderr: "No such file or directory\n", err: utilexec.CodeExitError{Err: errors.New("exit 1"), Code: 1}}
	switch {
	case len(argv) == 4 && argv[0] == "ls" && argv[1] == "-lindL" && argv[2] == "--":
		if f.gone {
			return missing
		}
		return fakeCommand{stdout: fmt.Sprintf(" %s -rw-r--r--    1 0        0  %d Oct  8 10:00 %s\n", f.inode, len(f.data), argv[3])}
	case len(argv) == 5 && argv[0] == "tail" && argv[1] == "-c" && strings.HasPrefix(argv[2], "+") && argv[3] == "--":
		f.tails++
		if f.gone {
			return missing
		}
		n, err := strconv.Atoi(argv[2][1:])
		if err != nil || n < 1 {
			return fakeCommand{err: fmt.Errorf("bad offset %q", argv[2])}
		}
		if n-1 >= len(f.data) {
			return fakeCommand{}
		}
		return fakeCommand{stdout: f.data[n-1:]}
	}
	return fakeCommand{err: fmt.Errorf("unexpected argv %v", argv)}
}

type sseEvent struct{ name, data string }

func TestLogFileStreamFollowsByPolling(t *testing.T) {
	orig := logFilePollInterval
	logFilePollInterval = 5 * time.Millisecond
	defer func() { logFilePollInterval = orig }()

	file := &fakeFile{inode: "11", data: "l1\nl2\nl3\n"}
	h, store, _ := logFileHandler(t, true, file.run)
	finished := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(finished)
		h.LogFileStream(w, withLogFileContext(r, "apps", "resource.pod.logfile"))
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/x?container=app&path=/var/log/app/app.log&lines=2", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("stream: %d %s", resp.StatusCode, resp.Header)
	}
	events := make(chan sseEvent, 64)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		name := ""
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				events <- sseEvent{name, strings.TrimPrefix(line, "data: ")}
				name = ""
			}
		}
		close(events)
	}()
	expect := func(step string, want ...sseEvent) {
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

	expect("the last 2 lines first", sseEvent{"", "l2"}, sseEvent{"", "l3"})
	file.update(func(f *fakeFile) { f.data += "l4\npar" })
	expect("an appended line; the partial one waits", sseEvent{"", "l4"})
	file.update(func(f *fakeFile) { f.data += "tial\n" })
	expect("the partial line once complete", sseEvent{"", "partial"})
	file.update(func(f *fakeFile) { f.data = "n1\n" })
	expect("truncated: from the start", sseEvent{"notice", "the file was replaced or truncated; following it from the start"}, sseEvent{"", "n1"})
	file.update(func(f *fakeFile) { f.gone = true })
	expect("rotation, file away", sseEvent{"notice", "the file is gone; waiting for it to come back"})
	file.update(func(f *fakeFile) { f.gone, f.inode, f.data = false, "12", "r1\nr2\n" })
	expect("rotation, new file from the start", sseEvent{"notice", "the file was replaced or truncated; following it from the start"}, sseEvent{"", "r1"}, sseEvent{"", "r2"})

	// The browser goes away: the handler returns and no command runs after that.
	cancel()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("the handler kept running after the client left")
	}
	var tails int
	file.update(func(f *fakeFile) { tails = f.tails })
	time.Sleep(50 * time.Millisecond)
	file.update(func(f *fakeFile) {
		if f.tails != tails {
			t.Errorf("tail kept running after the client left: %d → %d", tails, f.tails)
		}
	})
	if len(store.rows) != 1 || store.rows[0].Result == audit.ResultFailure || !strings.Contains(string(store.rows[0].After), `"follow":true`) {
		t.Fatalf("audit = %+v", store.rows)
	}
}

func TestLogFileStreamRefusesBeforeStreaming(t *testing.T) {
	// A missing file fails the first check: a plain 404, no stream, a failure row.
	exit1 := utilexec.CodeExitError{Err: errors.New("exit 1"), Code: 1}
	cases := []struct {
		name   string
		run    func(argv []string) fakeCommand
		status int
		reason string
	}{
		{"missing file", func([]string) fakeCommand {
			return fakeCommand{stderr: "ls: /var/log/app/app.log: No such file or directory\n", err: exit1}
		}, http.StatusNotFound, "no_file"},
		{"a directory", func([]string) fakeCommand {
			return fakeCommand{stdout: "765051 drwxr-xr-x 2 0 0 4096 Oct  8 09:43 /var/log/app/app.log\n"}
		}, http.StatusUnprocessableEntity, "failed"},
		{"unreadable", func(argv []string) fakeCommand {
			if argv[0] == "ls" {
				return fakeCommand{stdout: "765053 -rw------- 1 0 0 24147 Oct  8 10:00 /var/log/app/app.log\n"}
			}
			return fakeCommand{stderr: "tail: can't open '/var/log/app/app.log': Permission denied\n", err: exit1}
		}, http.StatusUnprocessableEntity, "unreadable"},
	}
	for _, c := range cases {
		h, store, _ := logFileHandler(t, true, c.run)
		w := httptest.NewRecorder()
		h.LogFileStream(w, logFileRequest("/x?container=app&path=/var/log/app/app.log", "apps", "resource.pod.logfile"))
		if w.Code != c.status || w.Header().Get("Content-Type") == "text/event-stream" || decodeLogFileError(t, w) != c.reason {
			t.Errorf("%s: %d %s %s", c.name, w.Code, w.Header(), w.Body)
		}
		if len(store.rows) != 1 || store.rows[0].Result != audit.ResultFailure {
			t.Errorf("%s audit = %+v", c.name, store.rows)
		}
	}
}

func TestParseLsLind(t *testing.T) {
	busybox := "  765053 -rw-r--r--    1 0        0            24147 Oct  8 10:00 /var/log/app/app.log"
	gnu := "2516731 -rw-r--r-- 1 0 0 21 Jul  4 09:05 /var/log/app/app.log"
	if st, ok := parseLsLind(busybox); !ok || st.inode != "765053" || st.size != 24147 {
		t.Errorf("busybox: %+v %v", st, ok)
	}
	if st, ok := parseLsLind(gnu); !ok || st.inode != "2516731" || st.size != 21 {
		t.Errorf("gnu: %+v %v", st, ok)
	}
	for _, bad := range []string{"", "765051 drwxr-xr-x 2 0 0 4096 Oct  8 09:43 /x", "1 crw-rw-rw- 1 0 0 1, 3 Oct 8 /dev/null", "1 -rw-r--r-- 1 0 0 big Oct 8 /x"} {
		if _, ok := parseLsLind(bad); ok {
			t.Errorf("parsed %q", bad)
		}
	}
}

func TestLineSplitter(t *testing.T) {
	var s lineSplitter
	s.reset(true) // a read that starts mid-file
	if got := s.feed([]byte("tial\nb\nc")); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("skip partial: %v", got)
	}
	if got := s.feed([]byte("d\r\ne\n")); !reflect.DeepEqual(got, []string{"cd", "e"}) {
		t.Fatalf("carry + CRLF: %v", got)
	}
	s.reset(true)
	if got := s.feed([]byte("still the first line")); got != nil {
		t.Fatalf("no newline yet while skipping: %v", got)
	}
	if got := s.feed([]byte(" ends\nnext\n")); !reflect.DeepEqual(got, []string{"next"}) {
		t.Fatalf("skip across chunks: %v", got)
	}
}

func TestCommandURLHasNoShellNoTTY(t *testing.T) {
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: "https://k8s.example:6443"})
	if err != nil {
		t.Fatal(err)
	}
	u := commandURL(cs, "apps", "web-0", "app", []string{"tail", "-n", "100", "--", "/var/log/app/a b.log"})
	q := u.Query()
	if u.Path != "/api/v1/namespaces/apps/pods/web-0/exec" || q.Get("container") != "app" {
		t.Fatalf("url = %s", u)
	}
	if got := q["command"]; !reflect.DeepEqual(got, []string{"tail", "-n", "100", "--", "/var/log/app/a b.log"}) {
		t.Fatalf("command = %v (each argv element is its own parameter, no shell)", got)
	}
	if q.Get("tty") == "true" || q.Get("stdin") == "true" || q.Get("stdout") != "true" || q.Get("stderr") != "true" {
		t.Fatalf("streams = %s", u.RawQuery)
	}
}

func TestTailBufferKeepsTheEnd(t *testing.T) {
	b := &tailBuffer{max: 10}
	for i := 0; i < 5; i++ {
		_, _ = b.Write([]byte(fmt.Sprintf("line-%d\n", i)))
	}
	if got := b.String(); got != "line-4\n" || !b.truncatedAtLine() || b.total != 35 {
		t.Fatalf("tail = %q truncatedAtLine=%v total=%d", got, b.truncatedAtLine(), b.total)
	}
	small := &tailBuffer{max: 100}
	_, _ = small.Write([]byte("a\nb\n"))
	if small.String() != "a\nb\n" || small.truncated {
		t.Fatalf("small = %q truncated=%v", small.String(), small.truncated)
	}
}
