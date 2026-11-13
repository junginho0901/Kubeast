package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/drain"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/recording"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
	utilexec "k8s.io/client-go/util/exec"
)

// Frames to the browser follow the API server's channel protocol the terminal
// already speaks: byte 0 is the channel, the rest is data.
const (
	shellStdout byte = 1
	shellStderr byte = 2
	shellError  byte = 3
)

// newShellExecutor builds the stream executor for u with cfg's transport and
// identity. WebSocket first, SPDY when the server or a proxy cannot upgrade —
// the order kubectl uses. Swapped in tests.
var newShellExecutor = func(cfg *rest.Config, u *url.URL) (remotecommand.Executor, error) {
	ws, err := remotecommand.NewWebSocketExecutor(cfg, "GET", u.String())
	if err != nil {
		return nil, err
	}
	spdy, err := remotecommand.NewSPDYExecutor(cfg, "POST", u)
	if err != nil {
		return nil, err
	}
	return remotecommand.NewFallbackExecutor(ws, spdy, func(err error) bool {
		return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err)
	})
}

// execURL is the exec subresource URL of the pod on cs's cluster.
func execURL(cs kubernetes.Interface, namespace, pod, container, command string) *url.URL {
	return cs.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(namespace).Name(pod).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: container,
			Command:   []string{command},
			Stdin:     true,
			Stdout:    true,
			Stderr:    true,
			TTY:       true,
		}, scheme.ParameterCodec).URL()
}

// commandURL is the exec subresource URL for one fixed command (argv, no
// shell) with stdout and stderr only: no TTY, no stdin.
func commandURL(cs kubernetes.Interface, namespace, pod, container string, argv []string) *url.URL {
	return cs.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(namespace).Name(pod).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: container,
			Command:   argv,
			Stdout:    true,
			Stderr:    true,
		}, scheme.ParameterCodec).URL()
}

// attachURL is the attach subresource URL of the pod on cs's cluster.
func attachURL(cs kubernetes.Interface, namespace, pod, container string) *url.URL {
	return cs.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(namespace).Name(pod).SubResource("attach").
		VersionedParams(&corev1.PodAttachOptions{
			Container: container,
			Stdin:     true,
			Stdout:    true,
			Stderr:    true,
			TTY:       true,
		}, scheme.ParameterCodec).URL()
}

// readFrames reads the browser's frames from conn (the socket's only reader)
// until it fails — the browser went away — and then closes the channel.
// It pings the browser meanwhile; no key and no pong for terminalPongWait
// is a browser gone without closing.
func readFrames(ctx context.Context, conn *websocket.Conn) <-chan []byte {
	in := make(chan []byte)
	reading := make(chan struct{})
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(terminalPongWait))
	})
	go pingTerminal(ctx, conn, reading)
	go func() {
		defer close(in)
		defer close(reading)
		for {
			// Set before each read: time spent handing a frame to a busy shell is not silence.
			_ = conn.SetReadDeadline(time.Now().Add(terminalPongWait))
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			select {
			case in <- data:
			case <-ctx.Done():
				return
			}
		}
	}()
	return in
}

// shellHangup is what the bridge types when the browser goes away under a
// shell: Ctrl-C ends the foreground job and clears the line, then Ctrl-D ends
// the shell (twice, for a shell started from the first one). A process started
// through exec or attach keeps running in the container after the stream
// drops, so this is said before closing. The keys go one at a time: a Ctrl-D
// that arrives with the Ctrl-C is lost while the shell handles the interrupt.
var (
	shellHangup      = [][]byte{{0x03}, {0x04}, {0x04}}
	shellHangupPause = 300 * time.Millisecond
	shellHangupGrace = 2 * time.Second
)

// recordingNotice is the line a recorded terminal starts with, in the screen's
// language ("ko"; English otherwise, also when the page sent none). It is part
// of the recording, so a reviewer replaying it reads the same line.
func recordingNotice(id, lang string) string {
	if strings.HasPrefix(strings.ToLower(lang), "ko") {
		return "\r\n[Kubeast] 이 세션은 녹화됩니다 (" + id + ").\r\n"
	}
	return "\r\n[Kubeast] This session is recorded (" + id + ").\r\n"
}

// sessionEndNotice is the line a terminal ends with when its session stopped standing, in the screen's language.
func sessionEndNotice(code, lang string) string {
	ko := strings.HasPrefix(strings.ToLower(lang), "ko")
	switch {
	case code == auth.SessionExpired && ko:
		return "\r\n[Kubeast] 세션 최대 시간이 지나 이 터미널을 닫았습니다. 다시 로그인하세요.\r\n"
	case code == auth.SessionExpired:
		return "\r\n[Kubeast] This terminal was closed: the session reached its maximum lifetime. Sign in again.\r\n"
	case code == auth.SessionUnverified && ko:
		return "\r\n[Kubeast] 세션을 확인할 수 없어 이 터미널을 닫았습니다. 다시 로그인하세요.\r\n"
	case code == auth.SessionUnverified:
		return "\r\n[Kubeast] This terminal was closed: the session could not be verified. Sign in again.\r\n"
	case ko:
		return "\r\n[Kubeast] 계정이나 권한이 바뀌어 이 터미널을 닫았습니다. 다시 로그인하세요.\r\n"
	default:
		return "\r\n[Kubeast] This terminal was closed: your account or access changed. Sign in again.\r\n"
	}
}

// serverLeavingNotice is the line a terminal gets when its server starts leaving: in how long it closes, in the
// screen's language. Part of the recording, as the other notices.
func serverLeavingNotice(in time.Duration, lang string) string {
	secs := max(0, int((in+time.Second/2)/time.Second))
	if strings.HasPrefix(strings.ToLower(lang), "ko") {
		return fmt.Sprintf("\r\n[Kubeast] 서버를 교체하고 있습니다. 이 터미널은 %d초 뒤 닫힙니다. 하던 일을 마치고 새 터미널을 여세요.\r\n", secs)
	}
	return fmt.Sprintf("\r\n[Kubeast] This server is being replaced: this terminal closes in %d s. Finish what you are doing, then open a new terminal.\r\n", secs)
}

// serverLeftNotice is the line a terminal ends with when its server was replaced.
func serverLeftNotice(lang string) string {
	if strings.HasPrefix(strings.ToLower(lang), "ko") {
		return "\r\n[Kubeast] 서버가 교체되어 이 터미널을 닫았습니다. 계속하려면 새 터미널을 여세요.\r\n"
	}
	return "\r\n[Kubeast] This terminal was closed: the server was replaced. Open a new terminal to continue.\r\n"
}

// serverEnded says why a held terminal ended when the server ended it — its session stopped standing
// (auth.LiveSessions) or the server is being replaced (drain) — with the line, close code and reason it gets. ok is
// false for any other end: the browser went away, the shell exited.
func serverEnded(ctx context.Context, lang string) (notice string, closeCode int, reason string, ok bool) {
	if code := auth.SessionEndCode(ctx); code != "" {
		return sessionEndNotice(code, lang), auth.SessionEndedCloseCode, code, true
	}
	if drain.Ended(ctx) {
		return serverLeftNotice(lang), drain.CloseCode, drain.Code, true
	}
	return "", 0, "", false
}

func hangUp(w io.Writer, pause time.Duration) {
	for i, key := range shellHangup {
		if i > 0 {
			time.Sleep(pause)
		}
		if _, err := w.Write(key); err != nil {
			return
		}
	}
}

// streamShell bridges the browser terminal to the pod stream at u, run on
// that cluster with cfg's identity. Browser frames arrive on in (readFrames)
// as raw keystrokes; pod output goes back on conn as channel frames. It
// returns when the process ends, the browser goes away, or ctx ends; a
// non-zero exit status is reported on the error channel and is not an error
// here. When the browser goes away first, the shell is hung up and given
// shellHangupGrace to end before the stream is cut.
//
// With rec set, the terminal output (what the user sees, not keystrokes) is
// also written to the recording, after a one-line notice that it is — in
// lang, the screen's language the page sent.
//
// A ctx ended by the session (auth.LiveSessions) or by the server leaving
// (drain) says why on the terminal and closes the socket, which from here on is
// a browser going away: the shell is hung up, not left running in the
// container. A server that starts leaving first says, on the terminal, when it
// will close (drain.Warning).
func streamShell(ctx context.Context, conn *websocket.Conn, in <-chan []byte, cfg *rest.Config, u *url.URL, rec *recording.Session, lang string) error {
	exec, err := newShellExecutor(cfg, u)
	if err != nil {
		return err
	}
	// Read once: the hang-up below can outlive this call.
	grace, pause := shellHangupGrace, shellHangupPause
	held := ctx
	ctx, cancel := context.WithCancel(context.WithoutCancel(held))
	defer cancel()

	out := &shellWriter{conn: conn, rec: rec}
	go func() {
		warned, closeAt := drain.Warning(held)
		for {
			select {
			case <-ctx.Done():
				return
			case <-warned:
				warned = nil
				_, _ = out.channel(shellStderr).Write([]byte(serverLeavingNotice(time.Until(closeAt()), lang)))
			case <-held.Done():
				notice, closeCode, reason, ended := serverEnded(held, lang)
				if !ended {
					cancel()
					return
				}
				_, _ = out.channel(shellStderr).Write([]byte(notice))
				_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(closeCode, reason), time.Now().Add(time.Second))
				_ = conn.Close()
				return
			}
		}
	}()
	if rec != nil {
		if _, err := out.channel(shellStdout).Write([]byte(recordingNotice(rec.ID, lang))); err != nil {
			return err
		}
	}
	stdinR, stdinW := io.Pipe()
	streamDone := make(chan struct{})
	go func() {
		defer cancel()
		defer stdinW.Close()
		// A first Enter draws the prompt.
		if _, err := stdinW.Write([]byte("\r")); err != nil {
			return
		}
		for data := range in {
			if len(data) == 0 {
				continue
			}
			if _, err := stdinW.Write(data); err != nil {
				return
			}
		}
		go hangUp(stdinW, pause)
		select {
		case <-streamDone:
		case <-time.After(grace):
		}
	}()

	err = exec.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:  stdinR,
		Stdout: out.channel(shellStdout),
		Stderr: out.channel(shellStderr),
		Tty:    true,
	})
	close(streamDone)
	_ = stdinR.Close()
	var exit utilexec.CodeExitError
	if errors.As(err, &exit) {
		_, _ = out.channel(shellError).Write([]byte(exit.Error()))
		return nil
	}
	if _, _, _, ended := serverEnded(held, ""); ended {
		return nil
	}
	return err
}

// shellWriter serialises writes to one WebSocket (gorilla allows a single
// concurrent writer) and hands out per-channel writers.
type shellWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
	rec  *recording.Session // nil: not recorded
}

func (w *shellWriter) channel(ch byte) io.Writer { return &channelWriter{w: w, ch: ch} }

type channelWriter struct {
	w  *shellWriter
	ch byte
}

func (c *channelWriter) Write(p []byte) (int, error) {
	frame := make([]byte, len(p)+1)
	frame[0] = c.ch
	copy(frame[1:], p)
	c.w.mu.Lock()
	defer c.w.mu.Unlock()
	if err := c.w.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
		return 0, err
	}
	if c.ch == shellStdout || c.ch == shellStderr {
		c.w.rec.Output(p)
	}
	return len(p), nil
}
