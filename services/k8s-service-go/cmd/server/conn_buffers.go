package main

import (
	"context"
	"net"
	"net/http"
	"time"
)

// connSendBufferBytes is the send buffer of each connection the server accepts (Linux keeps twice it). A body shared in
// Go, as the node list, is still copied into every socket's kernel queue, which the Go memory limit does not count.
const connSendBufferBytes = 128 << 10

// newHTTPServer is k8s-service's server. WriteTimeout 0 is for the WebSockets and event streams.
func newHTTPServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:         addr,
		Handler:      h,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 0,
		IdleTimeout:  120 * time.Second,
		ConnContext:  capSendBuffer,
	}
}

// capSendBuffer is the server's ConnContext; the connections k8s-service opens keep the kernel's sizing.
func capSendBuffer(ctx context.Context, c net.Conn) context.Context {
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetWriteBuffer(connSendBufferBytes)
	}
	return ctx
}
