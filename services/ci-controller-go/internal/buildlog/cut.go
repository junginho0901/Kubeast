// Package buildlog keeps a build's step logs after the build ends (design ⓒ
// §10, decision 34). While a build runs its logs are read live from the
// pods; what is kept is cut to a size per build, keeping the start of the
// build and the end of every step, where errors are written.
package buildlog

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"sync"
	"unicode/utf8"
)

const (
	// DefaultMaxBytes is what one build keeps from the start of its steps,
	// the same as a session recording (sessionRecording.maxBytes).
	DefaultMaxBytes = 64 << 20
	// DefaultTail is the end of a step kept after its log is cut.
	DefaultTail = 1 << 20
	// MinMaxBytes is the smallest MaxBytes allowed, as for recordings.
	MinMaxBytes = 4096
)

// Limit is how much of a build's logs is kept.
type Limit struct {
	// MaxBytes is kept from the start of the build's steps, in order.
	MaxBytes int64
	// Tail is the end of each step kept once the budget is spent, so the
	// end of every step survives; it comes on top of MaxBytes.
	Tail int
}

// DefaultLimit is MaxBytes 64 MiB and a 1 MiB tail.
func DefaultLimit() Limit { return Limit{MaxBytes: DefaultMaxBytes, Tail: DefaultTail} }

// Validate refuses a limit that would keep almost nothing.
func (l Limit) Validate() error {
	if l.MaxBytes < MinMaxBytes {
		return fmt.Errorf("build log maxBytes must be at least %d (got %d)", MinMaxBytes, l.MaxBytes)
	}
	if l.Tail < 0 || int64(l.Tail) > l.MaxBytes {
		return fmt.Errorf("build log tail must be between 0 and maxBytes (got %d)", l.Tail)
	}
	return nil
}

// Budget is one build's share of Limit.MaxBytes, spent by its steps in
// order. Safe for concurrent use.
type Budget struct {
	mu   sync.Mutex
	left int64
	tail int
}

// NewBudget starts a build's budget.
func NewBudget(l Limit) *Budget { return &Budget{left: l.MaxBytes, tail: l.Tail} }

func (b *Budget) remaining() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.left
}

func (b *Budget) take(n int64) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	n = min(n, b.left)
	b.left -= n
	return n
}

// Step cuts one step's log on its way to w.
func (b *Budget) Step(w io.Writer) *Cut { return &Cut{w: w, budget: b, tail: b.tail} }

// lineWindow is how far before the budget's end the head looks for a line
// break to end at; that much of a step is held back until it is known
// whether the step fits.
const lineWindow = 4096

// Cut passes a step's log to w while the build's budget lasts; after that
// it keeps the step's last bytes and drops the middle, and Close writes a
// note of what was dropped and those last bytes. The head ends at the last
// line break in its last 4 KiB, else at a character boundary; the tail
// starts after a line break where there is one, else at a character
// boundary. What is kept does not depend on how the log is split into
// writes. Not safe for concurrent use; one Cut is one step, and a build's
// steps are cut one after another.
type Cut struct {
	w      io.Writer
	budget *Budget
	tail   int
	cut    bool
	held   []byte // the end of the head not yet passed (at most lineWindow)
	buf    []byte // holds the last tail bytes once cut (cap 2×tail)
	last   byte   // the last byte passed to w
	read   int64  // bytes written to the Cut
	head   int64  // bytes of the head passed to w
	kept   int64  // bytes of the log passed to w, head and tail
	err    error
	closed bool
}

var errClosed = errors.New("buildlog: write after Close")

// Write fails only when w does; the limit never fails a write.
func (c *Cut) Write(p []byte) (int, error) {
	switch {
	case c.closed:
		return 0, errClosed
	case c.err != nil:
		return 0, c.err
	}
	n := len(p)
	c.read += int64(n)
	if c.cut {
		c.keep(p)
		return n, nil
	}
	// The step's head may reach end; bytes before end-lineWindow are sure
	// to be kept and go now.
	end := c.head + c.budget.remaining()
	sure := max(0, end-lineWindow)
	if len(c.held) == 0 && c.head < sure {
		k := int(min(int64(len(p)), sure-c.head))
		if err := c.passHead(p[:k]); err != nil {
			return k, err
		}
		p = p[k:]
	}
	held := c.head + int64(len(c.held))
	if held+int64(len(p)) <= end {
		c.held = append(c.held, p...)
		return n, nil
	}
	// The step does not fit: the head ends in the window before end.
	win := append(c.held, p[:end-held]...)
	next := p[end-held]
	k := len(win)
	if i := bytes.LastIndexByte(win, '\n'); i >= 0 {
		k = i + 1
	} else {
		for k > 0 && !utf8.RuneStart(next) {
			k--
			next = win[k]
		}
	}
	if err := c.passHead(win[:k]); err != nil {
		return n, err
	}
	// Once a step is cut the build's head is over: what is left of the
	// budget is not handed to later steps a few bytes at a time.
	c.budget.take(end - c.head)
	c.cut = true
	c.keep(win[k:])
	c.keep(p[end-held:])
	c.held = nil
	return n, nil
}

// passHead passes head bytes and spends the budget on them.
func (c *Cut) passHead(p []byte) error {
	c.budget.take(int64(len(p)))
	c.head += int64(len(p))
	return c.pass(p)
}

func (c *Cut) pass(p []byte) error {
	if len(p) == 0 {
		return nil
	}
	if _, err := c.w.Write(p); err != nil {
		c.err = err
		return err
	}
	c.kept += int64(len(p))
	c.last = p[len(p)-1]
	return nil
}

// keep adds p to the last bytes, copying down when the buffer fills, so a
// step of any length costs at most 2×tail of memory.
func (c *Cut) keep(p []byte) {
	if c.tail == 0 || len(p) == 0 {
		return
	}
	if c.buf == nil {
		c.buf = make([]byte, 0, 2*c.tail)
	}
	if len(p) >= c.tail {
		c.buf = append(c.buf[:0], p[len(p)-c.tail:]...)
		return
	}
	if len(c.buf)+len(p) > cap(c.buf) {
		c.buf = c.buf[:copy(c.buf, c.buf[len(c.buf)-(c.tail-len(p)):])]
	}
	c.buf = append(c.buf, p...)
}

// Close writes the note and the tail when the step was cut. It does not
// close w.
func (c *Cut) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	if c.err == nil && !c.cut {
		c.err = c.passHead(c.held)
	}
	if c.err != nil || !c.cut {
		return c.err
	}
	t := c.buf
	if len(t) > c.tail {
		t = t[len(t)-c.tail:]
	}
	if int64(len(t)) < c.read-c.kept {
		// Bytes before t were dropped: start after a line break, else at a
		// character boundary.
		if i := bytes.IndexByte(t, '\n'); i >= 0 && i+1 < len(t) {
			t = t[i+1:]
		} else {
			for len(t) > 0 && !utf8.RuneStart(t[0]) {
				t = t[1:]
			}
		}
	}
	dropped := c.read - c.kept - int64(len(t))
	if dropped == 0 {
		return c.pass(t)
	}
	note := fmt.Sprintf("[kubeast: %d bytes of this step were not kept (build log limit)]\n", dropped)
	if c.kept > 0 && c.last != '\n' {
		note = "\n" + note
	}
	if _, err := io.WriteString(c.w, note); err != nil {
		c.err = err
		return err
	}
	return c.pass(t)
}

// Read is how many bytes were written to the Cut.
func (c *Cut) Read() int64 { return c.read }

// Kept is how many of them were passed on (head and tail, not the note).
func (c *Cut) Kept() int64 { return c.kept }
