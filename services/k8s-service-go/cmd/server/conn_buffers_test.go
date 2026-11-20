package main

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

// Fifty callers reading slowly each get the whole of one shared answer of the node list's size, written as GetNodes
// writes it, through connections whose kernel queue holds a fraction of it.
func TestABigSharedAnswerArrivesWholeThroughCappedConnections(t *testing.T) {
	shared := make([]byte, 966_279)
	for i := range shared {
		shared[i] = byte('a' + i%26)
	}
	srv := newHTTPServer("", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(shared)
	}))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second}
	const callers = 50
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := client.Get("http://" + ln.Addr().String())
			if err != nil {
				errs <- err
				return
			}
			defer resp.Body.Close()
			var got bytes.Buffer
			chunk := make([]byte, 32<<10)
			for {
				n, err := resp.Body.Read(chunk)
				got.Write(chunk[:n])
				if err == io.EOF {
					break
				}
				if err != nil {
					errs <- err
					return
				}
				time.Sleep(2 * time.Millisecond) // a reader slower than the server writes
			}
			if !bytes.Equal(got.Bytes(), shared) {
				errs <- fmt.Errorf("got %d bytes, not the %d shared ones", got.Len(), len(shared))
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}
