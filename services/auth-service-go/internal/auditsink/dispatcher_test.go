package auditsink

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

type memStore struct {
	mu      sync.Mutex
	rows    []Event
	cursors map[string]int64
	fails   map[string]int
}

func newMemStore(n int) *memStore {
	s := &memStore{cursors: map[string]int64{}, fails: map[string]int{}}
	for i := 1; i <= n; i++ {
		action := "k8s.configmap.get"
		if i%3 == 0 {
			action = "k8s.pod.delete"
		}
		s.rows = append(s.rows, Event{ID: int64(i), Action: action, Result: "success", Time: time.Unix(int64(i), 0)})
	}
	return s
}

func (m *memStore) EnsureCursor(_ context.Context, sink string, start int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if v, ok := m.cursors[sink]; ok {
		return v, nil
	}
	m.cursors[sink] = start
	return start, nil
}
func (m *memStore) MaxID(context.Context) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return int64(len(m.rows)), nil
}
func (m *memStore) After(_ context.Context, after int64, limit int, _ time.Duration) ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Event
	for _, r := range m.rows {
		if r.ID > after && len(out) < limit {
			out = append(out, r)
		}
	}
	return out, nil
}
func (m *memStore) Advance(_ context.Context, sink string, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id > m.cursors[sink] {
		m.cursors[sink] = id
	}
	return nil
}
func (m *memStore) Fail(_ context.Context, sink, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.fails[sink]++
	return nil
}

type recSink struct {
	mu      sync.Mutex
	batches [][]Event
	failAt  int64 // fail any batch holding this id
}

func (r *recSink) Send(_ context.Context, ev []Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range ev {
		if e.ID == r.failAt {
			return errors.New("receiver down")
		}
	}
	r.batches = append(r.batches, append([]Event(nil), ev...))
	return nil
}

func run(sc SinkConfig, sink Sink) *sinkRun {
	n, w := sc.batchLimits()
	return &sinkRun{cfg: sc, sink: sink, maxEvents: n, maxWait: time.Duration(w) * time.Second}
}

func TestStepSendsFilteredChunksAndAdvances(t *testing.T) {
	store := newMemStore(10)
	sink := &recSink{}
	s := run(SinkConfig{Name: "slack", Type: "webhook", Filter: Filter{Actions: []string{"k8s.*.delete"}}, Batch: struct {
		MaxEvents      int `yaml:"maxEvents"`
		MaxWaitSeconds int `yaml:"maxWaitSeconds"`
	}{MaxEvents: 2}}, sink)
	d := &Dispatcher{store: store}
	next, full, err := d.step(context.Background(), s, 0)
	if err != nil || full {
		t.Fatalf("err %v full %v", err, full)
	}
	if next != 10 || store.cursors["slack"] != 10 {
		t.Fatalf("cursor %d / %d, want 10 (past filtered-out rows too)", next, store.cursors["slack"])
	}
	// ids 3, 6, 9 match; chunks of 2 → [3 6] [9]
	if len(sink.batches) != 2 || sink.batches[0][1].ID != 6 || sink.batches[1][0].ID != 9 {
		t.Fatalf("batches %+v", sink.batches)
	}
	if s.sent.Load() != 3 || s.pending.Load() != 0 {
		t.Fatalf("sent %d pending %d", s.sent.Load(), s.pending.Load())
	}
}

func TestStepFailureStopsBeforeTheFailedChunk(t *testing.T) {
	store := newMemStore(10)
	sink := &recSink{failAt: 9}
	s := run(SinkConfig{Name: "s", Type: "webhook", Filter: Filter{Actions: []string{"k8s.pod.delete"}}, Batch: struct {
		MaxEvents      int `yaml:"maxEvents"`
		MaxWaitSeconds int `yaml:"maxWaitSeconds"`
	}{MaxEvents: 2}}, sink)
	d := &Dispatcher{store: store}
	next, _, err := d.step(context.Background(), s, 0)
	if err == nil {
		t.Fatal("want the send error")
	}
	// [3 6] went out; [9] failed → cursor 8, so 9 is retried and 3, 6 are not resent.
	if next != 8 || store.cursors["s"] != 8 || store.fails["s"] != 1 || s.failures.Load() != 1 {
		t.Fatalf("cursor %d/%d fails %d", next, store.cursors["s"], store.fails["s"])
	}
	sink.failAt = 0
	next, _, err = d.step(context.Background(), s, next)
	if err != nil || next != 10 || len(sink.batches) != 2 || sink.batches[1][0].ID != 9 {
		t.Fatalf("recovery: next %d err %v batches %+v", next, err, sink.batches)
	}
}

type fakeLock struct{ calls int }

func (f *fakeLock) TryLock(context.Context) (func(), <-chan struct{}, bool, error) {
	f.calls++
	return func() {}, make(chan struct{}), true, nil
}

func TestRunStartsAtLatestForNotificationsAndExposesMetrics(t *testing.T) {
	store := newMemStore(5)
	sink := &recSink{}
	d := &Dispatcher{store: store, locker: &fakeLock{}, sleep: sleepCtx}
	d.sinks = []*sinkRun{run(SinkConfig{Name: "chat", Type: "webhook"}, sink), run(SinkConfig{Name: "archive", Type: "file"}, &recSink{})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { d.Run(ctx); close(done) }()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		c := store.cursors["archive"]
		store.mu.Unlock()
		if c == 5 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if store.cursors["chat"] != 5 || len(sink.batches) != 0 {
		t.Fatalf("a notification sink must start at the latest row without replaying: cursor %d batches %d", store.cursors["chat"], len(sink.batches))
	}
	if store.cursors["archive"] != 5 {
		t.Fatalf("an archive sink copies from the beginning: cursor %d", store.cursors["archive"])
	}
	reg := prometheus.NewRegistry()
	reg.MustRegister(d.Collector())
	if n := testutil.CollectAndCount(d.Collector()); n != 8 {
		t.Fatalf("leader reports 4 metrics × 2 sinks, got %d", n)
	}
	cancel()
	<-done
	if n := testutil.CollectAndCount(d.Collector()); n != 0 {
		t.Fatalf("a replica that is not sending reports nothing, got %d", n)
	}
}
