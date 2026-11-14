// Package drain ends the long-lived connections of a server that is being replaced (a rollout, a node drain, a scale
// down) in an order the person on the other end can follow, instead of cutting them when the process exits.
//
// net/http's Server.Shutdown neither closes nor waits for hijacked connections such as WebSockets, and it waits for an
// event stream until its context ends, so the terminals and the followed logs are held here instead:
//
//   - A followed log (HoldStream) ends as soon as the server starts leaving: the browser reconnects by itself and goes on
//     after the last line it got (Last-Event-ID), through the gateway, to a server that stays.
//   - A terminal (HoldTerminal) cannot be carried over — the shell in the pod ends with its stream — so it is told when it
//     will close (Warning), gets the wait to finish on its own, and only then ends.
//
// A held context ends with a *LeavingError as its cause (Ended), which the handlers turn into the close code
// CloseCode with the reason Code, the event Code, and the audit row k8s.session.end.
package drain

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Code is the reason a terminal or a followed log is given when its server is being replaced.
const Code = "server_shutdown"

// CloseCode is RFC 6455 §7.4.1's 1001 "going away": the server is going down.
const CloseCode = 1001

// LeavingError is the cancel cause of a held context whose server is leaving.
type LeavingError struct{}

func (*LeavingError) Error() string { return "server shutting down" }

// Ended reports whether ctx ended because its server is leaving.
func Ended(ctx context.Context) bool {
	var leaving *LeavingError
	return errors.As(context.Cause(ctx), &leaving)
}

type holdKind int

const (
	kindStream holdKind = iota
	kindTerminal
)

type hold struct {
	kind   holdKind
	cancel context.CancelCauseFunc
}

// Drain holds the long-lived connections of one server. The zero value is not usable; a nil *Drain holds nothing.
type Drain struct {
	mu        sync.Mutex
	leaving   bool
	closeAt   time.Time
	warned    chan struct{} // closed when Run starts
	holds     map[*hold]struct{}
	terminals int
	released  chan struct{} // a hold went away; buffered 1, never closed
}

// New returns a Drain with nothing held.
func New() *Drain {
	return &Drain{warned: make(chan struct{}), holds: map[*hold]struct{}{}, released: make(chan struct{}, 1)}
}

type holdKey struct{}

// HoldTerminal ties a terminal to the server's stay. Release it when the terminal ends.
func (d *Drain) HoldTerminal(ctx context.Context) (context.Context, func()) {
	return d.hold(ctx, kindTerminal)
}

// HoldStream ties a followed log to the server's stay. Release it when the stream ends.
func (d *Drain) HoldStream(ctx context.Context) (context.Context, func()) {
	return d.hold(ctx, kindStream)
}

func (d *Drain) hold(ctx context.Context, kind holdKind) (context.Context, func()) {
	if d == nil {
		return ctx, func() {}
	}
	held, cancel := context.WithCancelCause(ctx)
	h := &hold{kind: kind, cancel: cancel}
	d.mu.Lock()
	leaving := d.leaving
	d.holds[h] = struct{}{}
	if kind == kindTerminal {
		d.terminals++
	}
	d.mu.Unlock()
	if leaving {
		// came in after the server started leaving: nothing to wait for
		cancel(&LeavingError{})
	}
	var once sync.Once
	return context.WithValue(held, holdKey{}, d), func() {
		once.Do(func() {
			cancel(nil)
			d.mu.Lock()
			delete(d.holds, h)
			if kind == kindTerminal {
				d.terminals--
			}
			d.mu.Unlock()
			select {
			case d.released <- struct{}{}:
			default:
			}
		})
	}
}

// Warning is closed when the server holding ctx (HoldTerminal) starts leaving; closeAt then says when the terminal
// will be closed. A context no Drain holds gets a nil channel, which never closes.
func Warning(ctx context.Context) (warned <-chan struct{}, closeAt func() time.Time) {
	d, _ := ctx.Value(holdKey{}).(*Drain)
	if d == nil {
		return nil, func() time.Time { return time.Time{} }
	}
	return d.warned, func() time.Time {
		d.mu.Lock()
		defer d.mu.Unlock()
		return d.closeAt
	}
}

// Leaving reports whether Run has started: a new terminal or stream is refused from then on.
func (d *Drain) Leaving() bool {
	if d == nil {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.leaving
}

// Open counts the terminals and the followed logs held now.
func (d *Drain) Open() (terminals, streams int) {
	if d == nil {
		return 0, 0
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.terminals, len(d.holds) - d.terminals
}

// Result is what Run did.
type Result struct {
	Streams       int // followed logs ended at the start
	TerminalsLeft int // terminals that ended within the wait
	TerminalsCut  int // terminals still open when the wait was over
	Unreleased    int // holds still not released after closeWait
}

// Run starts leaving: the followed logs end at once and the terminals are warned (Warning). It returns when every
// terminal has ended or wait is over, whichever comes first; the terminals still open then end too, and Run waits up
// to closeWait more for their handlers to say so and release their holds (a shell is hung up before its stream is cut).
// Only the first call does anything.
func (d *Drain) Run(wait, closeWait time.Duration) Result {
	var res Result
	if d == nil {
		return res
	}
	d.mu.Lock()
	if d.leaving {
		d.mu.Unlock()
		return res
	}
	d.leaving = true
	d.closeAt = time.Now().Add(wait)
	close(d.warned)
	terminalsAtStart := d.terminals
	var streams []*hold
	for h := range d.holds {
		if h.kind == kindStream {
			streams = append(streams, h)
		}
	}
	d.mu.Unlock()
	for _, h := range streams {
		h.cancel(&LeavingError{})
	}
	res.Streams = len(streams)

	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for waiting := true; waiting; {
		terminals, _ := d.Open()
		if terminals == 0 {
			break
		}
		select {
		case <-d.released:
		case <-deadline.C:
			waiting = false
		}
	}

	d.mu.Lock()
	var cut []*hold
	for h := range d.holds {
		if h.kind == kindTerminal {
			cut = append(cut, h)
		}
	}
	d.mu.Unlock()
	res.TerminalsCut = len(cut)
	res.TerminalsLeft = max(0, terminalsAtStart-len(cut))
	for _, h := range cut {
		h.cancel(&LeavingError{})
	}

	closing := time.NewTimer(closeWait)
	defer closing.Stop()
	for {
		d.mu.Lock()
		n := len(d.holds)
		d.mu.Unlock()
		if n == 0 {
			return res
		}
		select {
		case <-d.released:
		case <-closing.C:
			res.Unreleased = n
			return res
		}
	}
}
