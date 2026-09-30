package handler

import (
	"context"
	"errors"
	"io"
	"net/url"
	"sync"

	"github.com/gorilla/websocket"
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

// streamShell bridges the browser terminal on conn to the pod stream at u,
// run on that cluster with cfg's identity. Browser frames are raw keystrokes;
// pod output goes back as channel frames. It returns when the process ends,
// the browser goes away, or ctx ends; a non-zero exit status is reported on
// the error channel and is not an error here.
func streamShell(ctx context.Context, conn *websocket.Conn, cfg *rest.Config, u *url.URL) error {
	exec, err := newShellExecutor(cfg, u)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	out := &shellWriter{conn: conn}
	stdinR, stdinW := io.Pipe()
	go func() {
		defer cancel()
		defer stdinW.Close()
		// A first Enter draws the prompt.
		if _, err := stdinW.Write([]byte("\r")); err != nil {
			return
		}
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if len(data) == 0 {
				continue
			}
			if _, err := stdinW.Write(data); err != nil {
				return
			}
		}
	}()

	err = exec.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:  stdinR,
		Stdout: out.channel(shellStdout),
		Stderr: out.channel(shellStderr),
		Tty:    true,
	})
	_ = stdinR.Close()
	var exit utilexec.CodeExitError
	if errors.As(err, &exit) {
		_, _ = out.channel(shellError).Write([]byte(exit.Error()))
		return nil
	}
	return err
}

// shellWriter serialises writes to one WebSocket (gorilla allows a single
// concurrent writer) and hands out per-channel writers.
type shellWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
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
	return len(p), nil
}
