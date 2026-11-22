//go:build linux

package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

type acceptedConnKey struct{}

// Each connection the server accepts keeps at most twice connSendBufferBytes unsent in the kernel, also after a write
// bigger than that; without the cap the kernel sizes a loopback socket's queue at about 2.5 MiB.
func TestAcceptedConnectionsKeepLittleUnsentInTheKernel(t *testing.T) {
	want := keptSendBuffer(connSendBufferBytes)
	before, after := sendBufferAroundABigAnswer(t, newHTTPServer("", nil))
	if before != want || after != want {
		t.Fatalf("SO_SNDBUF %d before and %d after a 1 MiB answer, want %d", before, after, want)
	}

	uncapped := newHTTPServer("", nil)
	uncapped.ConnContext = nil
	if got, _ := sendBufferAroundABigAnswer(t, uncapped); got == want {
		t.Fatalf("SO_SNDBUF %d without capSendBuffer too: the test reads nothing the cap sets", got)
	}
}

// keptSendBuffer is SO_SNDBUF after SetWriteBuffer(n): Linux keeps twice n, n taken at most net.core.wmem_max.
func keptSendBuffer(n int) int {
	if b, err := os.ReadFile("/proc/sys/net/core/wmem_max"); err == nil {
		if most, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && most < n {
			n = most
		}
	}
	return 2 * n
}

// sendBufferAroundABigAnswer serves one GET of 1 MiB with srv and gives SO_SNDBUF of the accepted socket before and
// after the handler's write.
func sendBufferAroundABigAnswer(t *testing.T, srv *http.Server) (before, after int) {
	t.Helper()
	type reading struct {
		before, after int
		err           error
	}
	read := make(chan reading, 1)
	body := make([]byte, 1<<20)
	next := srv.ConnContext
	srv.ConnContext = func(ctx context.Context, c net.Conn) context.Context {
		if next != nil {
			ctx = next(ctx, c)
		}
		return context.WithValue(ctx, acceptedConnKey{}, c)
	}
	srv.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Context().Value(acceptedConnKey{}).(net.Conn)
		var got reading
		got.before, got.err = sendBufferOf(c)
		_, _ = w.Write(body)
		w.(http.Flusher).Flush()
		if got.err == nil {
			got.after, got.err = sendBufferOf(c)
		}
		read <- got
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	resp, err := http.Get("http://" + ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	n, err := io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if err != nil || n != int64(len(body)) {
		t.Fatalf("read %d of %d bytes: %v", n, len(body), err)
	}
	got := <-read
	if got.err != nil {
		t.Fatal(got.err)
	}
	return got.before, got.after
}

func sendBufferOf(c net.Conn) (int, error) {
	tc, ok := c.(*net.TCPConn)
	if !ok {
		return 0, fmt.Errorf("the accepted connection is a %T, not a *net.TCPConn", c)
	}
	raw, err := tc.SyscallConn()
	if err != nil {
		return 0, err
	}
	var n int
	var opErr error
	if err := raw.Control(func(fd uintptr) {
		n, opErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF)
	}); err != nil {
		return 0, err
	}
	return n, opErr
}
