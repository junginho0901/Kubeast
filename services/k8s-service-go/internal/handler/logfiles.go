package handler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/tools/remotecommand"
	utilexec "k8s.io/client-go/util/exec"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logfiles"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Log files inside a container (chart features.logFiles): for applications
// that write their logs to files instead of stdout. Kubeast runs fixed ls and
// tail commands through the user's pods/exec, never a shell:
//
//	ls -1p -- <dir>              list the files the configured patterns cover
//	tail -n N -- <path>          read the last N lines
//	ls -lindL -- <path>          size and inode, when following
//	tail -c +OFFSET -- <path>    the bytes from OFFSET on, when following
//
// Only paths matching a configured pattern are read; with namespaces set,
// only pods in those namespaces. Reads are audited as k8s.pod.logfile.read.
const (
	permLogFile        = "resource.pod.logfile"
	auditLogFileRead   = "k8s.pod.logfile.read"
	logFileReadMax     = 8 << 20 // bytes one read returns; the end of the output is kept
	logFileStderrMax   = 4 << 10
	logFileLineMax     = 1 << 20 // longest line the stream forwards
	logFileHeartbeat   = 20 * time.Second
	logFileDefaultTail = 100
)

// containerCommandFunc runs argv in the container as the signed-in user.
type containerCommandFunc func(ctx context.Context, namespace, pod, container string, argv []string, stdout, stderr io.Writer) error

// SetLogFilePatterns sets the files the log files view may read.
func (h *Handler) SetLogFilePatterns(ps logfiles.Patterns) { h.logFilePatterns = ps }

// nonNilStrings keeps an unset list as [] in JSON.
func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (h *Handler) runContainerCommand(ctx context.Context, namespace, pod, container string, argv []string, stdout, stderr io.Writer) error {
	if h.logFileExec != nil {
		return h.logFileExec(ctx, namespace, pod, container, argv, stdout, stderr)
	}
	cfg, err := h.svc.UserRESTConfigFor(ctx)
	if err != nil {
		return err
	}
	cs, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		return err
	}
	exec, err := newShellExecutor(cfg, commandURL(cs, namespace, pod, container, argv))
	if err != nil {
		return err
	}
	return exec.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: stdout, Stderr: stderr})
}

// logFileError is a refusal or failure with the status and a short reason the
// screen can explain.
type logFileError struct {
	status int
	reason string // disabled, namespace, path, lines, forbidden, not_found (pod), no_file, tool_missing, unreadable, failed
	detail string
}

func (e *logFileError) Error() string { return e.detail }

func writeLogFileError(w http.ResponseWriter, e *logFileError) {
	response.JSON(w, e.status, map[string]string{"detail": e.detail, "reason": e.reason})
}

// logFileGate runs the checks every log files route shares, before any
// audit: the feature is on and the caller holds resource.pod.logfile here.
func (h *Handler) logFileGate(w http.ResponseWriter, r *http.Request) bool {
	if !h.cfg.LogFilesEnabled {
		writeLogFileError(w, &logFileError{http.StatusNotFound, "disabled", "log files are not enabled"})
		return false
	}
	if err := h.requirePermissionForCluster(r, permLogFile); err != nil {
		h.handleError(w, err)
		return false
	}
	return true
}

func (h *Handler) logFileNamespaceError(namespace string) *logFileError {
	if len(h.cfg.LogFilesNamespaces) == 0 || slices.Contains(h.cfg.LogFilesNamespaces, namespace) {
		return nil
	}
	return &logFileError{http.StatusForbidden, "namespace", fmt.Sprintf("log files are not enabled in namespace %q", namespace)}
}

// classifyCommandError maps an exec failure to a status. stderr is what the
// command printed (tail and ls report a missing file there and exit 1).
func classifyCommandError(err error, stderr string) *logFileError {
	msg := strings.TrimSpace(stderr)
	lower := strings.ToLower(msg + " " + err.Error())
	var exit utilexec.CodeExitError
	switch {
	case apierrors.IsForbidden(err):
		return &logFileError{http.StatusForbidden, "forbidden", "Kubernetes refused pods/exec for your account in this namespace"}
	case apierrors.IsNotFound(err):
		return &logFileError{http.StatusNotFound, "not_found", "pod or container not found"}
	case apierrors.IsBadRequest(err):
		return &logFileError{http.StatusBadRequest, "failed", err.Error()}
	case strings.Contains(lower, "executable file not found"),
		errors.As(err, &exit) && (exit.Code == 126 || exit.Code == 127):
		return &logFileError{http.StatusUnprocessableEntity, "tool_missing", "this container has no tail or ls, so its files cannot be read"}
	case errors.As(err, &exit) && strings.Contains(lower, "no such file"):
		return &logFileError{http.StatusNotFound, "no_file", "file not found"}
	case errors.As(err, &exit) && strings.Contains(lower, "permission denied"):
		return &logFileError{http.StatusUnprocessableEntity, "unreadable", "the container user cannot read this file"}
	case errors.As(err, &exit):
		if msg == "" {
			msg = exit.Error()
		}
		return &logFileError{http.StatusUnprocessableEntity, "failed", msg}
	case strings.Contains(lower, "forbidden"):
		return &logFileError{http.StatusForbidden, "forbidden", "Kubernetes refused pods/exec for your account in this namespace"}
	}
	return &logFileError{statusForError(err), "failed", err.Error()}
}

// ListLogFiles handles GET /api/v1/namespaces/{namespace}/pods/{name}/logfiles?container=.
// Names only, no content, so it is not audited.
func (h *Handler) ListLogFiles(w http.ResponseWriter, r *http.Request) {
	if !h.logFileGate(w, r) {
		return
	}
	namespace, pod, container := chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), r.URL.Query().Get("container")
	if e := h.logFileNamespaceError(namespace); e != nil {
		writeLogFileError(w, e)
		return
	}
	files := []map[string]string{}
	for _, dir := range h.logFilePatterns.Dirs() {
		var stdout, stderr bytes.Buffer
		err := h.runContainerCommand(r.Context(), namespace, pod, container, []string{"ls", "-1p", "--", dir}, &stdout, &limitedWriter{w: &stderr, n: logFileStderrMax})
		if err != nil {
			e := classifyCommandError(err, stderr.String())
			if e.reason == "no_file" {
				continue // the directory does not exist in this container
			}
			writeLogFileError(w, e)
			return
		}
		for _, p := range h.logFilePatterns.Match(dir, strings.Split(stdout.String(), "\n")) {
			files = append(files, map[string]string{"path": p})
		}
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"files":     files,
		"patterns":  h.logFilePatterns.List(),
		"max_lines": h.cfg.LogFilesMaxLines,
	})
}

// logFileRequest parses path and lines and checks them against the
// configuration. min is the smallest line count the route takes.
func (h *Handler) logFileRequest(r *http.Request, min int) (path string, lines int, e *logFileError) {
	path = r.URL.Query().Get("path")
	if !h.logFilePatterns.Allowed(path) {
		return path, 0, &logFileError{http.StatusBadRequest, "path", "path is not covered by the configured log file patterns"}
	}
	lines = logFileDefaultTail
	if v := r.URL.Query().Get("lines"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < min {
			return path, 0, &logFileError{http.StatusBadRequest, "lines", fmt.Sprintf("lines must be a number of at least %d", min)}
		}
		lines = n
	}
	if max := h.cfg.LogFilesMaxLines; max > 0 && lines > max {
		lines = max
	}
	return path, lines, nil
}

func logFileAuditAfter(container, path string, lines int, follow bool) []byte {
	return audit.MustJSON(map[string]interface{}{"container": container, "path": path, "lines": lines, "follow": follow})
}

// refuseLogFile records a refused or failed read (the caller passed the
// permission check) and answers it. Without the row the answer is 503.
func (h *Handler) refuseLogFile(w http.ResponseWriter, r *http.Request, namespace, pod string, after []byte, e *logFileError) {
	if werr := h.recordAuditWithPayload(r, auditLogFileRead, "pod", pod, namespace, e, nil, after); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	writeLogFileError(w, e)
}

// GetLogFileContent handles GET …/pods/{name}/logfiles/content?container=&path=&lines=:
// the last lines of one file as JSON.
func (h *Handler) GetLogFileContent(w http.ResponseWriter, r *http.Request) {
	if !h.logFileGate(w, r) {
		return
	}
	namespace, pod, container := chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), r.URL.Query().Get("container")
	if rerr := h.auditReady(r); rerr != nil {
		h.refuseUnaudited(w, r, rerr)
		return
	}
	path, lines, e := h.logFileRequest(r, 1)
	after := logFileAuditAfter(container, path, lines, false)
	if e == nil {
		e = h.logFileNamespaceError(namespace)
	}
	if e != nil {
		h.refuseLogFile(w, r, namespace, pod, after, e)
		return
	}

	out := &tailBuffer{max: logFileReadMax}
	var stderr bytes.Buffer
	argv := []string{"tail", "-n", strconv.Itoa(lines), "--", path}
	if err := h.runContainerCommand(r.Context(), namespace, pod, container, argv, out, &limitedWriter{w: &stderr, n: logFileStderrMax}); err != nil {
		h.refuseLogFile(w, r, namespace, pod, after, classifyCommandError(err, stderr.String()))
		return
	}
	if werr := h.recordAuditWithPayload(r, auditLogFileRead, "pod", pod, namespace, nil, nil, after); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"container": container,
		"path":      path,
		"lines":     lines,
		"content":   out.String(),
		"truncated": out.truncated,
	})
}

// logFilePollInterval is how often a followed file is read again. Swapped in tests.
var logFilePollInterval = 2 * time.Second

const (
	logFileBytesPerLine = 1024    // the first read when following starts lines × this before the end
	logFilePollMax      = 4 << 20 // bytes one poll forwards; a file growing faster skips ahead
	logFileStatEvery    = 3       // polls between rotation checks
)

// fileStat is what ls -lindL reports for a regular file.
type fileStat struct {
	inode string
	size  int64
}

// parseLsLind reads "inode mode links uid gid size …", the same in busybox and
// GNU ls. A non-regular file (directory, device) does not parse.
func parseLsLind(out string) (fileStat, bool) {
	f := strings.Fields(out)
	if len(f) < 6 || !strings.HasPrefix(f[1], "-") {
		return fileStat{}, false
	}
	size, err := strconv.ParseInt(f[5], 10, 64)
	if err != nil || size < 0 {
		return fileStat{}, false
	}
	return fileStat{inode: f[0], size: size}, true
}

// lineSplitter turns byte chunks into complete lines. It holds back a trailing
// partial line until its newline arrives and, after a read that starts in the
// middle of the file, drops the first partial line.
type lineSplitter struct {
	carry       []byte
	skipPartial bool
}

func (s *lineSplitter) reset(skipPartial bool) {
	s.carry = nil
	s.skipPartial = skipPartial
}

func (s *lineSplitter) feed(p []byte) []string {
	data := append(s.carry, p...)
	s.carry = nil
	if s.skipPartial {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			return nil
		}
		data = data[i+1:]
		s.skipPartial = false
	}
	var lines []string
	for {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			break
		}
		lines = append(lines, strings.TrimSuffix(string(data[:i]), "\r"))
		data = data[i+1:]
	}
	if len(data) > logFileLineMax { // a line without end: forward what there is
		lines = append(lines, string(data))
		data = nil
	}
	s.carry = append([]byte(nil), data...)
	return lines
}

// LogFileStream handles GET …/pods/{name}/logfiles/stream?container=&path=&lines=:
// Server-Sent Events, one event per line. It does not run one long tail -F:
// the container runtime keeps an exec'd process running after its client is
// gone, so every closed tab would leave a tail behind in the application's
// container. Instead it reads the new bytes every logFilePollInterval with
// tail -c +OFFSET (a seek, not a scan) and checks size and inode with
// ls -lindL now and then to follow truncation and rotation. Every command
// ends at once. The file check and the first read run before the stream
// starts, so a missing or unreadable file, a missing tail or a refused exec
// is a plain status.
func (h *Handler) LogFileStream(w http.ResponseWriter, r *http.Request) {
	if !h.logFileGate(w, r) {
		return
	}
	namespace, pod, container := chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), r.URL.Query().Get("container")
	if rerr := h.auditReady(r); rerr != nil {
		h.refuseUnaudited(w, r, rerr)
		return
	}
	path, lines, e := h.logFileRequest(r, 0)
	after := logFileAuditAfter(container, path, lines, true)
	if e == nil {
		e = h.logFileNamespaceError(namespace)
	}
	if e != nil {
		h.refuseLogFile(w, r, namespace, pod, after, e)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	ctx := r.Context()
	run := func(argv []string, out io.Writer) *logFileError {
		var stderr bytes.Buffer
		if err := h.runContainerCommand(ctx, namespace, pod, container, argv, out, &limitedWriter{w: &stderr, n: logFileStderrMax}); err != nil {
			return classifyCommandError(err, stderr.String())
		}
		return nil
	}
	stat := func() (fileStat, *logFileError) {
		var out bytes.Buffer
		if e := run([]string{"ls", "-lindL", "--", path}, &limitedWriter{w: &out, n: logFileStderrMax}); e != nil {
			return fileStat{}, e
		}
		st, ok := parseLsLind(out.String())
		if !ok {
			return fileStat{}, &logFileError{http.StatusUnprocessableEntity, "failed", "not a regular file"}
		}
		return st, nil
	}
	// read forwards the bytes from offset to the end of the file; the buffer
	// counts every byte, kept or not, so the offset stays exact.
	read := func(offset int64, max int) (*tailBuffer, *logFileError) {
		tb := &tailBuffer{max: max}
		return tb, run([]string{"tail", "-c", "+" + strconv.FormatInt(offset+1, 10), "--", path}, tb)
	}

	st, e := stat()
	var first *tailBuffer
	var offset int64
	if e == nil {
		offset = st.size
		if lines > 0 {
			offset = max(0, st.size-int64(lines)*logFileBytesPerLine)
		}
		first, e = read(offset, logFileReadMax)
	}
	if e != nil {
		h.refuseLogFile(w, r, namespace, pod, after, e)
		return
	}
	if werr := h.recordAuditWithPayload(r, auditLogFileRead, "pod", pod, namespace, nil, nil, after); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	write := func(event, data string) bool {
		var err error
		if event != "" {
			_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, escapeSSE(data))
		} else {
			_, err = fmt.Fprintf(w, "data: %s\n\n", escapeSSE(data))
		}
		if err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	// stop ends the stream with the reason; the browser closes on "end".
	stop := func(e *logFileError) {
		slog.InfoContext(ctx, "log file stream stopped", "namespace", namespace, "pod", pod, "reason", e.reason, "detail", e.detail)
		write("error", e.detail)
		write("end", "stream ended")
	}

	// The first read: the last `lines` lines before the end (the first, partial
	// line dropped when the read starts mid-file).
	var split lineSplitter
	split.reset(offset > 0 && !first.truncatedAtLine())
	data := first.Bytes()
	offset += first.total
	got := split.feed(data)
	if len(got) > lines {
		got = got[len(got)-lines:]
	}
	for _, l := range got {
		if !write("", l) {
			return
		}
	}

	poll := time.NewTicker(logFilePollInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(logFileHeartbeat)
	defer heartbeat.Stop()
	polls, missing := 0, false
	// gone notes once that the file disappeared (rotation in progress, or
	// deleted); polling then checks for it until it is back.
	gone := func() bool {
		if missing {
			return true
		}
		missing = true
		return write("notice", "the file is gone; waiting for it to come back")
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			// A comment line keeps proxies (nginx: 60 s idle) from closing a quiet stream.
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-poll.C:
			polls++
			if missing || polls%logFileStatEvery == 0 {
				now, e := stat()
				if e != nil && e.reason == "no_file" {
					if !gone() {
						return
					}
					continue
				}
				if e != nil {
					stop(e)
					return
				}
				if missing || now.inode != st.inode || now.size < offset {
					if !write("notice", "the file was replaced or truncated; following it from the start") {
						return
					}
					missing, offset = false, 0
					split.reset(false)
				}
				st = now
			}
			tb, e := read(offset, logFilePollMax)
			if e != nil && e.reason == "no_file" {
				if !gone() {
					return
				}
				continue
			}
			if e != nil {
				stop(e)
				return
			}
			chunk := tb.Bytes()
			offset += tb.total
			if skipped := tb.total - int64(len(chunk)); skipped > 0 {
				if !write("notice", fmt.Sprintf("skipped %d bytes: the file grows faster than it can be followed", skipped)) {
					return
				}
				split.reset(!tb.truncatedAtLine())
			}
			for _, l := range split.feed(chunk) {
				if !write("", l) {
					return
				}
			}
		}
	}
}

// tailBuffer keeps the last max bytes written to it, from a line start when
// there is one, and counts every byte written.
type tailBuffer struct {
	buf       []byte
	max       int
	total     int64 // bytes written, kept or not
	truncated bool  // bytes were dropped from the front
	cutAtLine bool  // after a drop, buf starts right after a newline
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.total += int64(len(p))
	t.buf = append(t.buf, p...)
	if len(t.buf) > 2*t.max {
		t.trim()
	}
	return len(p), nil
}

func (t *tailBuffer) trim() {
	if len(t.buf) <= t.max {
		return
	}
	cut := len(t.buf) - t.max
	t.cutAtLine = t.buf[cut-1] == '\n'
	if !t.cutAtLine {
		if i := bytes.IndexByte(t.buf[cut:], '\n'); i >= 0 && cut+i+1 < len(t.buf) {
			cut += i + 1
			t.cutAtLine = true
		}
	}
	t.buf = append([]byte(nil), t.buf[cut:]...)
	t.truncated = true
}

func (t *tailBuffer) Bytes() []byte {
	t.trim()
	return t.buf
}

func (t *tailBuffer) String() string { return string(t.Bytes()) }

// truncatedAtLine reports that bytes were dropped and what is left starts at a line.
func (t *tailBuffer) truncatedAtLine() bool {
	t.trim()
	return t.truncated && t.cutAtLine
}

// limitedWriter keeps the first n bytes and discards the rest without error,
// so a chatty stderr never fails the command.
type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := min(len(p), l.n)
		if _, err := l.w.Write(p[:k]); err != nil {
			return 0, err
		}
		l.n -= k
	}
	return len(p), nil
}
