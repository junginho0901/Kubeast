package metrics

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

// codeClientLeft is what a request counts as when its client had left before a 500 was written: the number the gateway's
// access log has for it. It is a label's value and nothing else; the answer itself stays the handler's 500.
const codeClientLeft = "499"

// leftWithin is how young a request must be for its gone client to count as one that left. A wait that ran out looks the
// same from here: the console's own (10 s or more, frontend/src/services/api/client.ts), the gateway's (60 s, nginx's
// default, or more), the calls between the services, and a body that outlasts the server's ReadTimeout (10 s or more),
// whose client is still there. A 500 past leftWithin stays one, so KubeastHighErrorRate goes on counting the answers
// that came too late.
const leftWithin = 5 * time.Second

type answerKey struct{}

// answer is the writer a counted handler writes to. It sends what it is given, unchanged, and keeps the status the
// metrics count the request under: the last one written, as promhttp's own writer keeps it.
type answer struct {
	http.ResponseWriter
	request    context.Context // the request's: net/http ends it with Canceled when the client's connection goes
	start      time.Time
	leftWithin time.Duration
	status     int
	wrote      bool
	left       bool
}

// countedCode is the code label of the request whose context this is.
func countedCode(ctx context.Context) string {
	a, ok := ctx.Value(answerKey{}).(*answer)
	switch {
	case !ok || a.status == 0:
		return "200" // nothing written: net/http sends 200
	case a.left && a.status == http.StatusInternalServerError:
		return codeClientLeft
	case a.status < 100 || a.status > 599:
		return "unknown"
	}
	return strconv.Itoa(a.status)
}

// WriteHeader reads whether the client is still there as the first status goes out: a client that leaves after its answer
// was answered.
func (a *answer) WriteHeader(code int) {
	if !a.wrote {
		a.left = errors.Is(a.request.Err(), context.Canceled) && time.Since(a.start) < a.leftWithin
	}
	a.status, a.wrote = code, true
	a.ResponseWriter.WriteHeader(code)
}

func (a *answer) begin() {
	if !a.wrote {
		a.WriteHeader(http.StatusOK)
	}
}

func (a *answer) Write(b []byte) (int, error) {
	a.begin()
	return a.ResponseWriter.Write(b)
}

// ReadFrom keeps io.Copy on the connection's own copy.
func (a *answer) ReadFrom(src io.Reader) (int64, error) {
	rf, ok := a.ResponseWriter.(io.ReaderFrom)
	if !ok {
		return io.Copy(struct{ io.Writer }{a}, src)
	}
	a.begin()
	return rf.ReadFrom(src)
}

// Flush keeps event streams and followed logs flushing.
func (a *answer) Flush() {
	if f, ok := a.ResponseWriter.(http.Flusher); ok {
		a.begin()
		f.Flush()
	}
}

// Hijack keeps WebSocket upgrades working.
func (a *answer) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := a.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	return hj.Hijack()
}

// Unwrap is for http.ResponseController.
func (a *answer) Unwrap() http.ResponseWriter { return a.ResponseWriter }
