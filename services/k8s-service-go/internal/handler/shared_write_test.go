package handler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

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
	const turn = 50 * time.Millisecond // wide enough that a busy runner does not make the fast writer look slow
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

// writeWaits reads the write place wait histogram as a scrape would, failing on any label but service and places.
func writeWaits(t *testing.T) (uint64, float64) {
	t.Helper()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(BigWriteWaitCollectors()...)
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	if len(families) != 1 || len(families[0].GetMetric()) != 1 {
		t.Fatalf("%d families gathered, want the one series", len(families))
	}
	s := families[0].GetMetric()[0]
	labels := map[string]string{}
	for _, l := range s.GetLabel() {
		labels[l.GetName()] = l.GetValue()
	}
	if name := families[0].GetName(); name != "kubeast_shared_write_place_wait_seconds" ||
		!maps.Equal(labels, map[string]string{"service": "k8s", "places": "big_write"}) {
		t.Fatalf("%s labelled %v", name, labels)
	}
	return s.GetHistogram().GetSampleCount(), s.GetHistogram().GetSampleSum()
}

// Each take of a write place is one observation of its wait, a take that stopped waiting too: none for a body one
// socket's kernel queue holds, about 0 when a place was free, the wait until a place was given back, the wait until the
// deadline before a body written without a place, and one for each part of a reader slower than the turn, which gives
// its place back after each part and takes one again for the next.
func TestEachTakeOfAWritePlaceIsObserved(t *testing.T) {
	ctx := context.Background()
	since := func(count uint64, sum float64) (uint64, float64) {
		c, s := writeWaits(t)
		return c - count, s - sum
	}

	count, sum := writeWaits(t)
	small := make([]byte, bigSharedBody)
	if err := writeInTurns(ctx, &paced{total: len(small)}, small, limits.NewSlots("test", 1), bigWriteTurn, bigWriteWait); err != nil {
		t.Fatal(err)
	}
	if n, _ := since(count, sum); n != 0 {
		t.Errorf("a body of %d bytes took a place %d times, want none", len(small), n)
	}
	body := nodeListSized()
	places := limits.NewSlots("test", 1)
	if err := writeInTurns(ctx, &paced{total: len(body)}, body, places, time.Minute, time.Minute); err != nil {
		t.Fatal(err)
	}
	if n, s := since(count, sum); n != 1 || s > 0.5 {
		t.Errorf("a big body with a place free: %d observations summing %.3f s, want 1 of about 0", n, s)
	}

	// the one place held: a body waits 50 ms and is written without one, the next gets it given back after 100 ms
	give, err := places.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	count, sum = writeWaits(t)
	if err := writeInTurns(ctx, &paced{total: len(body)}, body, places, time.Minute, 50*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	time.AfterFunc(100*time.Millisecond, give)
	if err := writeInTurns(ctx, &paced{total: len(body)}, body, places, time.Minute, time.Minute); err != nil {
		t.Fatal(err)
	}
	if n, s := since(count, sum); n != 2 || s < 0.14 || s > 2 {
		t.Errorf("%d observations summing %.3f s, want 2 summing about 0.15", n, s)
	}

	const turn = time.Millisecond
	parts := (len(body) + bigWritePart - 1) / bigWritePart
	count, sum = writeWaits(t)
	if err := writeInTurns(ctx, &paced{pause: 2 * turn, total: len(body)}, body, places, turn, time.Minute); err != nil {
		t.Fatal(err)
	}
	if n, _ := since(count, sum); n != uint64(parts) {
		t.Errorf("a reader slower than the turn: %d observations, want one for each of its %d parts", n, parts)
	}
}

// A caller that leaves while it waits for a place after part of its body went out gets errLeftPartWay, which
// writeShared turns into a cut connection (http.ErrAbortHandler) rather than a body that ends as if whole; one that left
// before any part went out has nothing to cut.
func TestACallerThatLeavesPartWayGetsACutConnection(t *testing.T) {
	body := nodeListSized()
	places := limits.NewSlots("test", 1)
	const turn = 50 * time.Millisecond
	ctx, leave := context.WithCancel(context.Background())
	defer leave()
	w := &paced{pause: 3 * turn, total: len(body), began: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- writeInTurns(ctx, w, body, places, turn, time.Minute) }()
	<-w.began
	give, err := places.Take(context.Background()) // the place it gives back after its slow first part
	if err != nil {
		t.Fatal(err)
	}
	defer give()
	leave()
	err = <-done
	if !errors.Is(err, errLeftPartWay) || w.written.Load() != bigWritePart {
		t.Fatalf("a caller gone after one part: %v with %d bytes written; want errLeftPartWay after %d", err, w.written.Load(), bigWritePart)
	}
	func() {
		defer func() {
			if r := recover(); r != http.ErrAbortHandler {
				t.Errorf("abortIfCut(%v) recovered %v, want http.ErrAbortHandler", err, r)
			}
		}()
		abortIfCut(err)
	}()
	abortIfCut(context.Canceled)
}

// Through a real socket, a body that writeShared writes reaches the client as one Write of it did: the same bytes,
// status and headers.
func TestASharedBodyGoesOutAsOneWriteOfItWould(t *testing.T) {
	body := nodeListSized()
	answer := func(write func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			write(w, r)
		}
	}
	get := func(h http.Handler) (*http.Response, []byte) {
		t.Helper()
		srv := httptest.NewServer(h)
		defer srv.Close()
		resp, err := http.Get(srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		got, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp, got
	}
	one, oneBody := get(answer(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }))
	shared, sharedBody := get(answer(func(w http.ResponseWriter, r *http.Request) { writeShared(w, r, body) }))
	if !bytes.Equal(oneBody, body) || !bytes.Equal(sharedBody, body) {
		t.Fatalf("bodies of %d (one Write) and %d (writeShared) bytes, want both the %d shared ones", len(oneBody), len(sharedBody), len(body))
	}
	if shared.StatusCode != one.StatusCode || shared.ContentLength != one.ContentLength ||
		!slices.Equal(shared.TransferEncoding, one.TransferEncoding) {
		t.Errorf("writeShared: %d, length %d, %v; one Write: %d, length %d, %v", shared.StatusCode, shared.ContentLength,
			shared.TransferEncoding, one.StatusCode, one.ContentLength, one.TransferEncoding)
	}
	one.Header.Del("Date")
	shared.Header.Del("Date")
	if !reflect.DeepEqual(shared.Header, one.Header) {
		t.Errorf("writeShared's headers %v, one Write's %v", shared.Header, one.Header)
	}
}
