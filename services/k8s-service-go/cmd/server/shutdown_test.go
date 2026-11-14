package main

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

// lastParts stands in for recording.Manager.Shutdown: each part is put with a
// timeout taken from the context it is given, as uploadNew does.
type lastParts struct{ err error }

func (p *lastParts) Shutdown(ctx context.Context) {
	putCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	select {
	case <-putCtx.Done():
		p.err = putCtx.Err()
	case <-time.After(50 * time.Millisecond): // the store answers
	}
}

func TestShutdownGivesTheRecorderItsOwnWaitAfterAStreamHeldTheServer(t *testing.T) {
	opened, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// a followed log: open until its client goes, not when the server shuts down
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(opened)
		<-release
	})}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln) }()
	resp, err := http.Get("http://" + ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	<-opened

	const serverWait = 200 * time.Millisecond
	rec := &lastParts{}
	began := time.Now()
	shutdown(srv, rec, serverWait, time.Second)
	if took := time.Since(began); took < serverWait {
		t.Fatalf("shutdown took %s: the stream did not hold the server for its wait", took)
	}
	if rec.err != nil {
		t.Fatalf("the recorder's last part failed after the server's wait: %v", rec.err)
	}
}
