package ws

import (
	"bytes"
	"context"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/junginho0901/kubeast/services/pkg/limits"
)

type placeWaits struct {
	count   uint64
	sum     float64
	waiting float64
}

// gatherWatchWaits reads w as a scrape would: the waits and the waiting watches by places, and the memory waits, failing
// on any label but service and places.
func gatherWatchWaits(t *testing.T, w *watchWaitMetrics) (map[string]placeWaits, float64) {
	t.Helper()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(w.collectors()...)
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	byPlaces, memory := map[string]placeWaits{}, -1.0
	for _, f := range families {
		for _, s := range f.GetMetric() {
			labels := map[string]string{}
			var names []string
			for _, l := range s.GetLabel() {
				labels[l.GetName()] = l.GetValue()
				names = append(names, l.GetName())
			}
			if labels["service"] != "k8s" {
				t.Errorf("%s service=%q, want k8s", f.GetName(), labels["service"])
			}
			p := byPlaces[labels["places"]]
			switch f.GetName() {
			case "kubeast_ws_watch_place_wait_seconds":
				if !slices.Equal(names, []string{"places", "service"}) {
					t.Errorf("%s labelled %v", f.GetName(), names)
				}
				p.count, p.sum = s.GetHistogram().GetSampleCount(), s.GetHistogram().GetSampleSum()
				byPlaces[labels["places"]] = p
			case "kubeast_ws_watches_waiting_for_place":
				if !slices.Equal(names, []string{"places", "service"}) {
					t.Errorf("%s labelled %v", f.GetName(), names)
				}
				p.waiting = s.GetGauge().GetValue()
				byPlaces[labels["places"]] = p
			case "kubeast_ws_watch_memory_waits_total":
				if !slices.Equal(names, []string{"service"}) {
					t.Errorf("%s labelled %v", f.GetName(), names)
				}
				memory = s.GetCounter().GetValue()
			default:
				t.Errorf("unexpected metric %s", f.GetName())
			}
		}
	}
	if keys := slices.Sorted(maps.Keys(byPlaces)); !slices.Equal(keys, []string{placesOpening, placesStart}) {
		t.Errorf("places %v, want opening and start only", keys)
	}
	return byPlaces, memory
}

// stopsAfter is places whose take stops waiting after a time that runs from the take's arrival at them, which is after its
// wait began to be timed: what is observed is never shorter than it.
type stopsAfter struct {
	placeTaker
	after time.Duration
}

func (s stopsAfter) Take(ctx context.Context) (func(), error) {
	ctx, cancel := context.WithTimeout(ctx, s.after)
	defer cancel()
	return s.placeTaker.Take(ctx)
}

// Each take of a watch's places is one observation under its places, a free place a few microseconds and a take that
// stopped waiting the time it waited; a watch is counted as waiting while it waits, and no longer once it has its place
// or stopped.
func TestEachTakeOfAWatchsPlacesIsTimedAndCountedWhileItWaits(t *testing.T) {
	m := NewMultiplexer(fakeClients{})
	m.waits = newWatchWaitMetrics()
	places := limits.NewSlots("watch start on c", 1)
	start := m.timed(placesStart, places)

	give, err := start.Take(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.timed(placesStart, stopsAfter{places, 30 * time.Millisecond}).Take(context.Background()); err == nil {
		t.Fatal("a second take of one place got it")
	}
	got, _ := gatherWatchWaits(t, m.waits)
	if s := got[placesStart]; s.count != 2 || s.sum < 0.03 || s.waiting != 0 {
		t.Fatalf("start %+v, want 2 takes, at least the 30 ms the second waited, none waiting", s)
	}

	took := make(chan func())
	go func() {
		g, err := start.Take(context.Background())
		if err != nil {
			t.Error(err)
		}
		took <- g
	}()
	deadline := time.Now().Add(2 * time.Second)
	for got, _ = gatherWatchWaits(t, m.waits); got[placesStart].waiting != 1; got, _ = gatherWatchWaits(t, m.waits) {
		if time.Now().After(deadline) {
			t.Fatalf("waiting %v, want the third take counted while it waits", got[placesStart].waiting)
		}
		time.Sleep(time.Millisecond)
	}
	give()
	(<-took)()
	if got, _ = gatherWatchWaits(t, m.waits); got[placesStart].waiting != 0 || got[placesStart].count != 3 {
		t.Fatalf("start %+v after the third took its place, want 3 takes, none waiting", got[placesStart])
	}

	g, err := m.timed(placesOpening, m.openingPlaces().placesFor("c")).Take(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	g()
	if got, _ = gatherWatchWaits(t, m.waits); got[placesOpening].count != 1 || got[placesStart].count != 3 {
		t.Fatalf("waits %+v, want the opening's take under opening only", got)
	}
}

// A watch from no version on a socket takes a start place and an opening place, each observed once; a Helm stream's
// StartWatch takes a start place.
func TestAWatchsStartObservesItsStartAndOpeningPlaces(t *testing.T) {
	m := muxOn(t, eventThenHold)
	m.waits = newWatchWaitMetrics()
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "default", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("frame %s, want DATA", f.Type)
	}
	got, _ := gatherWatchWaits(t, m.waits)
	if got[placesStart].count != 1 || got[placesOpening].count != 1 {
		t.Fatalf("waits %+v, want one start and one opening", got)
	}
	release, err := m.StartWatch(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	release()
	if got, _ = gatherWatchWaits(t, m.waits); got[placesStart].count != 2 {
		t.Fatalf("start %+v after StartWatch, want 2", got[placesStart])
	}
}

// lineCounter is a slog handler that keeps the lines it is given.
type lineCounter struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (c *lineCounter) Enabled(context.Context, slog.Level) bool { return true }
func (c *lineCounter) Handle(_ context.Context, r slog.Record) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buf.WriteString(r.Message)
	r.Attrs(func(a slog.Attr) bool {
		c.buf.WriteString(" " + a.String())
		return true
	})
	c.buf.WriteString("\n")
	return nil
}
func (c *lineCounter) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c *lineCounter) WithGroup(string) slog.Handler      { return c }

func (c *lineCounter) lines(word string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, l := range strings.Split(c.buf.String(), "\n") {
		if strings.Contains(l, word) {
			out = append(out, l)
		}
	}
	return out
}

// Every new watch told to wait for memory, on a socket or as a watch from no version, is counted; the log says so once
// per memoryWaitLogEvery with how many were told since the last line and the memory held against the limit.
func TestNewWatchesToldToWaitForMemoryAreCountedAndLogged(t *testing.T) {
	logs := &lineCounter{}
	was := slog.Default()
	slog.SetDefault(slog.New(logs))
	t.Cleanup(func() { slog.SetDefault(was) })

	m := muxOn(t, eventThenHold)
	m.waits = newWatchWaitMetrics()
	m.heap = func() (uint64, uint64) { return 900 << 20, 1000 << 20 }
	conn := socketTo(t, m, everyCluster)
	for _, q := range []string{"watch=1", "watch=1&labelSelector=a%3D1", "watch=1&labelSelector=a%3D2"} {
		request(t, conn, "REQUEST", "default", "/api/v1/pods", q)
		if f := nextFrame(t, conn); f.Type != "ERROR" || f.Error.Reason != reasonLimit {
			t.Fatalf("%s: frame %s %s, want the limit frame", q, f.Type, f.Error.Reason)
		}
	}
	if _, memory := gatherWatchWaits(t, m.waits); memory != 3 {
		t.Fatalf("memory waits %v, want 3", memory)
	}
	lines := logs.lines("short of memory")
	if len(lines) != 1 || !strings.Contains(lines[0], "watches=1") || !strings.Contains(lines[0], "held_mib=900") || !strings.Contains(lines[0], "limit_mib=1000") {
		t.Fatalf("log lines %q, want one naming 1 watch, 900 of 1000 MiB", lines)
	}

	m.waits.nextLog.Store(0) // the next line is due
	m.toldMemoryShort()
	if lines = logs.lines("short of memory"); len(lines) != 2 || !strings.Contains(lines[1], "watches=3") {
		t.Fatalf("log lines %q, want a second naming the 3 told since the first", lines)
	}
}
