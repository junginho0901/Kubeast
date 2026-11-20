package handler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/limits"
)

// nodeListSized is a body of the node list's size on 1 001 nodes.
func nodeListSized() []byte {
	b := make([]byte, 966_279)
	for i := range b {
		b[i] = byte('a' + i%26)
	}
	return b
}

// paced stands for the reader at the other end of one connection: each Write takes pause.
type paced struct {
	pause       time.Duration
	total       int
	got         bytes.Buffer // read once the write has returned
	written     atomic.Int64
	began       chan struct{} // closed at the first Write, when set
	under, most *atomic.Int64 // bodies begun and not yet whole, when set
}

func (p *paced) Write(b []byte) (int, error) {
	if p.got.Len() == 0 {
		if p.began != nil {
			close(p.began)
		}
		if p.under != nil {
			n := p.under.Add(1)
			for m := p.most.Load(); n > m && !p.most.CompareAndSwap(m, n); m = p.most.Load() {
			}
		}
	}
	time.Sleep(p.pause)
	p.got.Write(b)
	p.written.Add(int64(len(b)))
	if p.under != nil && p.got.Len() == p.total {
		p.under.Add(-1)
	}
	return len(b), nil
}

// Forty callers of one shared body of the node list's size each get it byte for byte, and no more than bigWritePlaces
// of the bodies are under way at once: each keeps its place from part to part while its reader keeps up.
func TestBigSharedWritesTakeTurns(t *testing.T) {
	body := nodeListSized()
	places := limits.NewSlots("test", bigWritePlaces)
	var under, most atomic.Int64
	const callers = 40
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := &paced{pause: time.Millisecond, total: len(body), under: &under, most: &most}
			if err := writeInTurns(context.Background(), w, body, places, time.Minute, time.Minute); err != nil {
				errs <- err
				return
			}
			if !bytes.Equal(w.got.Bytes(), body) {
				errs <- fmt.Errorf("got %d bytes, not the %d shared ones", w.got.Len(), len(body))
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if n := most.Load(); n > bigWritePlaces {
		t.Errorf("%d bodies under way at once, past the %d places", n, bigWritePlaces)
	}
	if n := places.InUse(); n != 0 {
		t.Errorf("%d places still taken after every write ended", n)
	}
}

// With one place, a reader slower than the turn gives the place back after its part: a writer that came after it is
// done while the slow one has written a part or two of its body.
func TestASlowReaderDoesNotHoldItsPlaceFromTheOthers(t *testing.T) {
	body := nodeListSized()
	places := limits.NewSlots("test", 1)
	const turn = 10 * time.Millisecond
	slow := &paced{pause: 3 * turn, total: len(body), began: make(chan struct{})}
	fast := &paced{total: len(body)}
	slowDone := make(chan error, 1)
	go func() { slowDone <- writeInTurns(context.Background(), slow, body, places, turn, time.Minute) }()
	<-slow.began
	if err := writeInTurns(context.Background(), fast, body, places, turn, time.Minute); err != nil {
		t.Fatal(err)
	}
	atFastDone := slow.written.Load()
	if err := <-slowDone; err != nil {
		t.Fatal(err)
	}
	if atFastDone > 3*bigWritePart {
		t.Errorf("the slow reader had %d of %d bytes when the other was done: it held the place", atFastDone, len(body))
	}
	if !bytes.Equal(slow.got.Bytes(), body) || !bytes.Equal(fast.got.Bytes(), body) {
		t.Errorf("bodies of %d and %d bytes, want both the %d shared ones", slow.got.Len(), fast.got.Len(), len(body))
	}
	if n := places.InUse(); n != 0 {
		t.Errorf("%d places still taken after both writes ended", n)
	}
}

// A body that one socket's kernel queue holds is written at once and waits for no place; a big one whose caller left
// while it waited writes nothing.
func TestOnlyABigBodyWaitsForAPlaceAndStopsWhenItsCallerLeaves(t *testing.T) {
	places := limits.NewSlots("test", 1)
	give, err := places.Take(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer give()
	gone, leave := context.WithCancel(context.Background())
	leave()

	small := make([]byte, bigSharedBody)
	w := &paced{total: len(small)}
	if err := writeInTurns(gone, w, small, places, bigWriteTurn, bigWriteWait); err != nil || !bytes.Equal(w.got.Bytes(), small) {
		t.Fatalf("a body of %d bytes with every place taken: %d written, %v", len(small), w.got.Len(), err)
	}

	big := nodeListSized()
	w = &paced{total: len(big)}
	err = writeInTurns(gone, w, big, places, bigWriteTurn, bigWriteWait)
	if !errors.Is(err, context.Canceled) || w.written.Load() != 0 {
		t.Fatalf("a big body whose caller left: %d bytes written, %v; want none and context.Canceled", w.written.Load(), err)
	}
}

// With every place held by writers that do not move (readers that stopped reading), a big body waits for one no longer
// than wait and is then written whole without one, and counted: no body stops behind them.
func TestABigBodyIsWrittenWithoutAPlaceWhenNoneComesInTime(t *testing.T) {
	places := limits.NewSlots("test", bigWritePlaces)
	for range bigWritePlaces {
		give, err := places.Take(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		defer give()
	}
	const wait = 50 * time.Millisecond
	body := nodeListSized()
	w := &paced{total: len(body)}
	counted := BigWritesWithoutPlace()
	began := time.Now()
	if err := writeInTurns(context.Background(), w, body, places, bigWriteTurn, wait); err != nil {
		t.Fatal(err)
	}
	took := time.Since(began)
	if !bytes.Equal(w.got.Bytes(), body) {
		t.Fatalf("got %d bytes, not the %d shared ones", w.got.Len(), len(body))
	}
	if took < wait {
		t.Errorf("written after %s, before the %s it waits for a place", took, wait)
	}
	if n := BigWritesWithoutPlace() - counted; n != 1 {
		t.Errorf("%d writes counted without a place, want 1", n)
	}
	if n := places.InUse(); n != bigWritePlaces {
		t.Errorf("%d places taken, want the %d held before: the write took one", n, bigWritePlaces)
	}
}
