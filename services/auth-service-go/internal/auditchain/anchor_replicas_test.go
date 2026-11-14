package auditchain

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"
)

// sharedStore is one database several replicas use: every call holds mu, and
// AnchorLocked holds lock while fn runs, as the advisory lock does.
type sharedStore struct {
	*fakeStore
	mu   sync.Mutex
	lock sync.Mutex
}

func (s *sharedStore) AnchorLocked(_ context.Context, fn func(Store) error) error {
	s.lock.Lock()
	defer s.lock.Unlock()
	return fn(s)
}

func (s *sharedStore) Head(ctx context.Context) (Head, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fakeStore.Head(ctx)
}

func (s *sharedStore) Bounds(ctx context.Context) (int64, int64, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fakeStore.Bounds(ctx)
}

func (s *sharedStore) LastAnchor(ctx context.Context) (*Anchor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fakeStore.LastAnchor(ctx)
}

func (s *sharedStore) LastAnchorBy(ctx context.Context, actor string) (*Anchor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fakeStore.LastAnchorBy(ctx, actor)
}

func (s *sharedStore) InsertAnchor(ctx context.Context, a Anchor) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fakeStore.InsertAnchor(ctx, a)
}

func (s *sharedStore) ReviewHashesBetween(ctx context.Context, since, until time.Time) ([]ReviewHash, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fakeStore.ReviewHashesBetween(ctx, since, until)
}

// slowObjects is a sink whose PUT takes a while: two anchors written without
// the lock both read the same previous anchor before either is inserted.
type slowObjects struct {
	*fakeObjects
	mu sync.Mutex
}

func (o *slowObjects) PutObject(ctx context.Context, key string, body []byte, contentType string, meta map[string]string) error {
	time.Sleep(50 * time.Millisecond)
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.fakeObjects.PutObject(ctx, key, body, contentType, meta)
}

func (o *slowObjects) GetObject(ctx context.Context, key string) ([]byte, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.fakeObjects.GetObject(ctx, key)
}

// assertLinear fails unless each anchor starts after the one before and
// links to its hash.
func assertLinear(t *testing.T, anchors []Anchor) {
	t.Helper()
	for i, a := range anchors {
		if i == 0 {
			if a.PrevAnchorHash != nil {
				t.Errorf("first anchor %d links to %x", a.ID, a.PrevAnchorHash)
			}
			continue
		}
		p := anchors[i-1]
		if !bytes.Equal(a.PrevAnchorHash, p.AnchorHash) || a.FromSeq != p.ToSeq+1 {
			t.Errorf("anchor %d links to %x from %d; want anchor %d's %x from %d", a.ID, a.PrevAnchorHash, a.FromSeq, p.ID, p.AnchorHash, p.ToSeq+1)
		}
	}
}

// at runs fns together, released at one moment.
func at(fns ...func()) {
	start := make(chan struct{})
	var wg sync.WaitGroup
	for _, fn := range fns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			fn()
		}()
	}
	close(start)
	wg.Wait()
}

func TestReplicasTickingAtOneMomentWriteOneAnchor(t *testing.T) {
	store := &sharedStore{fakeStore: chainOf(5)}
	objects := &slowObjects{fakeObjects: newFakeObjects()}
	now := time.Date(2026, 11, 14, 3, 0, 0, 0, time.UTC)
	replicas := make([]*Anchorer, 4)
	audits := make([]*memAudit, len(replicas))
	wrote := make([]bool, len(replicas))
	var fns []func()
	for i := range replicas {
		audits[i] = &memAudit{}
		replicas[i] = &Anchorer{Store: store, Objects: objects, Sink: "archive", Audit: audits[i], Now: func() time.Time { return now }}
		fns = append(fns, func() {
			_, w, err := replicas[i].RunOnce(context.Background(), 24*time.Hour)
			if err != nil {
				t.Errorf("replica %d: %v", i, err)
			}
			wrote[i] = w
		})
	}
	at(fns...)

	if len(store.anchors) != 1 {
		t.Fatalf("anchors = %d, want 1: %+v", len(store.anchors), store.anchors)
	}
	writers, records := 0, 0
	for i := range replicas {
		if wrote[i] {
			writers++
		}
		records += len(audits[i].recs)
		if replicas[i].LastAt() != now.Unix() {
			t.Errorf("replica %d LastAt = %d, want the anchor's %d", i, replicas[i].LastAt(), now.Unix())
		}
	}
	if writers != 1 || records != 1 {
		t.Fatalf("replicas that wrote = %d, audit.chain.anchor rows = %d; want 1 and 1", writers, records)
	}
}

func TestAReplicaTickingLaterInThePeriodWritesNothingAndTakesOverWhenTheWriterStops(t *testing.T) {
	f := chainOf(5)
	var now time.Time
	clock := func() time.Time { return now }
	a := &Anchorer{Store: f, Objects: newFakeObjects(), Sink: "archive", Now: clock}
	b := &Anchorer{Store: f, Objects: a.Objects, Sink: "archive", Now: clock}
	day := 24 * time.Hour
	t0 := time.Date(2026, 11, 14, 3, 0, 0, 0, time.UTC)
	tick := func(r *Anchorer, when time.Time) bool {
		t.Helper()
		now = when
		_, wrote, err := r.RunOnce(context.Background(), day)
		if err != nil {
			t.Fatal(err)
		}
		return wrote
	}
	seal := func(ids ...int64) {
		for _, id := range ids {
			f.unsealed = append(f.unsealed, Unsealed{ID: id, Canon: "row"})
		}
		f.SealBatch(context.Background(), 10)
	}

	if !tick(a, t0) {
		t.Fatal("a did not write the first anchor")
	}
	if tick(b, t0.Add(9*time.Hour)) {
		t.Fatal("b wrote a second anchor in the period a anchored")
	}
	if b.LastAt() != t0.Unix() {
		t.Errorf("b LastAt = %d, want a's anchor at %d", b.LastAt(), t0.Unix())
	}
	seal(201, 202)
	if !tick(a, t0.Add(day)) {
		t.Fatal("a did not write the next period's anchor")
	}
	if tick(b, t0.Add(day+9*time.Hour)) {
		t.Fatal("b wrote a second anchor in a's next period")
	}
	// a stops: b's next tick finds the last anchor more than a period old.
	seal(203)
	if !tick(b, t0.Add(2*day+9*time.Hour)) {
		t.Fatal("b did not take over once a stopped")
	}
	if len(f.anchors) != 3 {
		t.Fatalf("anchors = %d, want 3: %+v", len(f.anchors), f.anchors)
	}
	assertLinear(t, f.anchors)
}

func TestOneReplicaAnchorsEveryPeriodAsBefore(t *testing.T) {
	f := chainOf(3)
	var now time.Time
	a := &Anchorer{Store: f, Objects: newFakeObjects(), Sink: "archive", Now: func() time.Time { return now }}
	day := 24 * time.Hour
	t0 := time.Date(2026, 11, 14, 3, 0, 0, 0, time.UTC)
	// The first tick's anchor is written five minutes after the tick (a slow
	// database), and an admin anchors in between: each next tick still writes.
	ticks := []time.Time{t0.Add(5 * time.Minute), t0.Add(day), t0.Add(2 * day)}
	for i, when := range ticks {
		now = when
		if _, wrote, err := a.RunOnce(context.Background(), day); err != nil || !wrote {
			t.Fatalf("tick %d at %s: wrote = %v err = %v", i, when, wrote, err)
		}
		if i == 0 {
			now = t0.Add(3 * time.Hour)
			if _, err := a.AnchorOnce(context.Background(), "admin@example.com"); err != nil {
				t.Fatal(err)
			}
		}
	}
	var actors []string
	for _, an := range f.anchors {
		actors = append(actors, an.Actor)
	}
	if len(actors) != 4 || actors[0] != "system" || actors[1] != "admin@example.com" || actors[2] != "system" || actors[3] != "system" {
		t.Fatalf("anchors by %v, want system, the admin, system, system", actors)
	}
	assertLinear(t, f.anchors)
}

func TestAnchorNowDuringTheScheduledAnchorWritesAfterItAndOnIt(t *testing.T) {
	store := &sharedStore{fakeStore: chainOf(5)}
	objects := &slowObjects{fakeObjects: newFakeObjects()}
	now := time.Date(2026, 11, 14, 3, 0, 0, 0, time.UTC)
	scheduled := &Anchorer{Store: store, Objects: objects, Sink: "archive", Now: func() time.Time { return now }}
	admin := &Anchorer{Store: store, Objects: objects, Sink: "archive", Now: func() time.Time { return now }}
	at(func() {
		if _, wrote, err := scheduled.RunOnce(context.Background(), 24*time.Hour); err != nil || !wrote {
			t.Errorf("scheduled: wrote = %v err = %v", wrote, err)
		}
	}, func() {
		if _, err := admin.AnchorOnce(context.Background(), "admin@example.com"); err != nil {
			t.Errorf("anchor now: %v", err)
		}
	})
	if len(store.anchors) != 2 {
		t.Fatalf("anchors = %d, want 2: %+v", len(store.anchors), store.anchors)
	}
	assertLinear(t, store.anchors)
}
