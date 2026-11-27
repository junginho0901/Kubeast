package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/junginho0901/kubeast/services/pkg/limits"
)

// A big body several callers are given (the node list and node box answers, shared or not, the Pods page's and the node
// map's, and a shared read's answer to those who waited), longer than one socket's kernel queue holds under the server's
// send buffer cap (cmd/server connSendBufferBytes, doubled), is written bigWritePart at a time holding one of
// bigWritePlaces. The node list is built again each second while its callers wait for it, and they then wrote it all at
// once: 73 copies of 0.9 MiB in 30 ms, each kept by its socket's kernel outside the Go memory limit.
const (
	bigSharedBody  = 256 << 10
	bigWritePart   = 64 << 10
	bigWritePlaces = 16
	bigWriteTurn   = 100 * time.Millisecond
	bigWriteWait   = time.Second
)

var (
	bigWriteSlots         = limits.NewSlots("big shared answer write", bigWritePlaces)
	bigWritesWithoutPlace atomic.Int64
)

// errLeftPartWay is writeInTurns' answer for a caller that left while it waited for a place after part of the body had
// gone out.
var errLeftPartWay = errors.New("caller left part way through a shared body")

// writePlaceWaitBuckets are internal/k8s clientWaitBuckets, so the two wait histograms share their le.
var writePlaceWaitBuckets = []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60}

// bigWriteWaited times each take of a write place in writeInTurns, a take that stopped waiting too, under
// places="big_write". A take waits at most until its body's deadline (placeWait), so no observation passes bigWriteWait.
var bigWriteWaited = prometheus.NewHistogram(prometheus.HistogramOpts{
	Name:        "kubeast_shared_write_place_wait_seconds",
	Help:        "Seconds a node list, node box, Pods page, node map or shared read answer past 256 KiB waited for one of the write places, each time it took one (a few microseconds when one was free), a take that stopped waiting too.",
	ConstLabels: prometheus.Labels{"service": "k8s", "places": "big_write"},
	Buckets:     writePlaceWaitBuckets,
})

// placeWait is the seconds a take of a place begun at start waited, up to deadline and no further: a take that reached
// the deadline stopped there, and its timer firing late is no wait for a place (1 s would read as 1.000x s, past the
// le="1" bucket). A take begun after the deadline waited 0.
func placeWait(start, deadline time.Time) float64 {
	waited := time.Since(start)
	if most := max(deadline.Sub(start), 0); waited > most {
		waited = most
	}
	return waited.Seconds()
}

// BigWritesWithoutPlace is how many big bodies waited bigWriteWait in all for places and wrote the rest without one.
func BigWritesWithoutPlace() int64 { return bigWritesWithoutPlace.Load() }

// BigWriteWaitCollectors are the write place wait histogram, for the service's registry.
func BigWriteWaitCollectors() []prometheus.Collector { return []prometheus.Collector{bigWriteWaited} }

// writeShared writes body taking turns with the other big ones; the bytes are the same.
func writeShared(w http.ResponseWriter, r *http.Request, body []byte) {
	abortIfCut(writeInTurns(r.Context(), w, body, bigWriteSlots, bigWriteTurn, bigWriteWait))
}

// abortIfCut ends the connection without the end of the body for a body cut part way: a handler that returned would
// send the chunked end, and a client still reading would take the cut body as whole.
func abortIfCut(err error) {
	if errors.Is(err, errLeftPartWay) {
		panic(http.ErrAbortHandler)
	}
}

// writeInTurns keeps its place from part to part while each goes out within turn. A part that took longer, a reader
// slower than the others, gives the place back so the next writer goes first: a slow reader holds a place for one part,
// not its whole body. The waits for places share one deadline, wait from the start: past it the rest is written at
// once without a place, as before the places, so no body stops behind places held by readers that stopped reading. A
// caller that leaves while it waits writes nothing more, and errLeftPartWay says part of the body had gone out. Each
// take of a place is observed in bigWriteWaited, whether it got one or not, up to the deadline (placeWait).
func writeInTurns(ctx context.Context, w io.Writer, body []byte, places *limits.Slots, turn, wait time.Duration) error {
	if len(body) <= bigSharedBody {
		_, err := w.Write(body)
		return err
	}
	deadline := time.Now().Add(wait)
	started := false
	var give func()
	defer func() {
		if give != nil {
			give()
		}
	}()
	for len(body) > 0 {
		if give == nil {
			waitCtx, cancel := context.WithDeadline(ctx, deadline)
			start := time.Now()
			var err error
			give, err = places.Take(waitCtx)
			bigWriteWaited.Observe(placeWait(start, deadline))
			cancel()
			if err != nil {
				if ctx.Err() != nil {
					if started {
						return fmt.Errorf("%w: %w", errLeftPartWay, ctx.Err())
					}
					return ctx.Err()
				}
				bigWritesWithoutPlace.Add(1)
				_, err = w.Write(body)
				return err
			}
		}
		n := min(len(body), bigWritePart)
		began := time.Now()
		if _, err := w.Write(body[:n]); err != nil {
			return err
		}
		started = true
		body = body[n:]
		if time.Since(began) > turn {
			give()
			give = nil
		}
	}
	return nil
}
