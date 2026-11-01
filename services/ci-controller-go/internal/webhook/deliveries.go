package webhook

import (
	"sync"
	"time"
)

// Deliveries remembers the delivery IDs taken in the last TTL, so a
// delivery sent again — a replay, or a redelivery of one already queued
// (GitHub keeps the X-GitHub-Delivery of the original) — is not built twice.
// It holds at most Max IDs and forgets the oldest first. One controller
// replica keeps it in memory; several would share it in a store, which is
// why the handler takes the DeliveryStore interface.
type Deliveries struct {
	TTL time.Duration
	Max int

	mu    sync.Mutex
	seen  map[string]time.Time
	order []string // IDs in the order taken, oldest first
	head  int      // index of the oldest live entry in order
}

// DeliveryStore is what the handler needs from Deliveries.
type DeliveryStore interface {
	// Seen reports whether id was taken within the TTL.
	Seen(id string, now time.Time) bool
	// Take records id as taken.
	Take(id string, now time.Time)
}

// NewDeliveries keeps IDs for 24 hours, at most 100 000 of them (about 10 MB).
func NewDeliveries() *Deliveries {
	return &Deliveries{TTL: 24 * time.Hour, Max: 100_000}
}

func (d *Deliveries) Seen(id string, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.expire(now)
	t, ok := d.seen[id]
	return ok && now.Sub(t) < d.TTL
}

func (d *Deliveries) Take(id string, now time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.seen == nil {
		d.seen = map[string]time.Time{}
	}
	d.expire(now)
	if _, ok := d.seen[id]; ok {
		d.seen[id] = now
		return
	}
	for len(d.seen) >= d.Max && d.head < len(d.order) {
		delete(d.seen, d.order[d.head])
		d.head++
	}
	d.seen[id] = now
	d.order = append(d.order, id)
	d.compact()
}

// Len is the number of IDs remembered.
func (d *Deliveries) Len() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.seen)
}

// expire drops the IDs older than the TTL from the front of order. An ID
// taken again moved its time forward; it is kept while that time is live.
func (d *Deliveries) expire(now time.Time) {
	for d.head < len(d.order) {
		id := d.order[d.head]
		t, ok := d.seen[id]
		if ok && now.Sub(t) < d.TTL {
			break
		}
		if ok {
			delete(d.seen, id)
		}
		d.head++
	}
	d.compact()
}

// compact drops the forgotten front of order once it is half the slice.
func (d *Deliveries) compact() {
	if d.head > 0 && d.head*2 >= len(d.order) {
		d.order = append([]string(nil), d.order[d.head:]...)
		d.head = 0
	}
}
