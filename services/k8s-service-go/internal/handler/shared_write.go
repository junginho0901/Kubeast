package handler

import (
	"context"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/limits"
)

// A body made once for several callers and longer than one socket's kernel queue holds under the server's send buffer
// cap (cmd/server connSendBufferBytes, doubled) is written bigWritePart at a time holding one of bigWritePlaces. The
// node list is built again each second while its callers wait for it, and they then wrote it all at once: 73 copies of
// 0.9 MiB in 30 ms, each kept by its socket's kernel outside the Go memory limit.
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

// BigWritesWithoutPlace is how many big shared bodies got no place within bigWriteWait and were written without one.
func BigWritesWithoutPlace() int64 { return bigWritesWithoutPlace.Load() }

// writeShared writes body, made once for several callers (the node list, a node box, a shared read's answer), taking
// turns with the other big ones; the bytes are the same.
func writeShared(w http.ResponseWriter, r *http.Request, body []byte) {
	_ = writeInTurns(r.Context(), w, body, bigWriteSlots, bigWriteTurn, bigWriteWait)
}

// writeInTurns keeps its place from part to part while each goes out within turn. A part that took longer, a reader
// slower than the others, gives the place back so the next writer goes first: a slow reader holds a place for one part,
// not its whole body. A caller that leaves while it waits writes nothing more. A place that does not come within wait
// (the places held by readers that stopped reading) leaves the rest written at once without one, as before the places,
// so no body stops behind them.
func writeInTurns(ctx context.Context, w io.Writer, body []byte, places *limits.Slots, turn, wait time.Duration) error {
	if len(body) <= bigSharedBody {
		_, err := w.Write(body)
		return err
	}
	var give func()
	defer func() {
		if give != nil {
			give()
		}
	}()
	for len(body) > 0 {
		if give == nil {
			waitCtx, cancel := context.WithTimeout(ctx, wait)
			var err error
			give, err = places.Take(waitCtx)
			cancel()
			if err != nil {
				if ctx.Err() != nil {
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
		body = body[n:]
		if time.Since(began) > turn {
			give()
			give = nil
		}
	}
	return nil
}
