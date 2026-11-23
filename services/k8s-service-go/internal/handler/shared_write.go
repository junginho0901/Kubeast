package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/limits"
)

// A big body several callers are given (the node list and node box answers, shared or not, and a shared read's answer
// to those who waited), longer than one socket's kernel queue holds under the server's send buffer cap (cmd/server
// connSendBufferBytes, doubled), is written bigWritePart at a time holding one of bigWritePlaces. The node list is built
// again each second while its callers wait for it, and they then wrote it all at once: 73 copies of 0.9 MiB in 30 ms,
// each kept by its socket's kernel outside the Go memory limit.
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

// BigWritesWithoutPlace is how many big bodies waited bigWriteWait in all for places and wrote the rest without one.
func BigWritesWithoutPlace() int64 { return bigWritesWithoutPlace.Load() }

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
// caller that leaves while it waits writes nothing more, and errLeftPartWay says part of the body had gone out.
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
			var err error
			give, err = places.Take(waitCtx)
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
