package k8s

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// healthRows is the registry side of the checker: the clusters it lists and the statuses written.
type healthRows struct {
	mu      sync.Mutex
	metas   []cluster.Meta
	written map[cluster.ID]string
	listErr error
}

func (h *healthRows) ListMeta(context.Context) ([]cluster.Meta, error) { return h.metas, h.listErr }

func (h *healthRows) UpdateHealth(_ context.Context, id cluster.ID, status string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.written[id] = status
	return nil
}

type lockAnswer bool

func (l lockAnswer) Held(context.Context) bool { return bool(l) }

// Every replica probes each cluster for its own breaker; only the one holding the writer's lock
// writes clusters.health_status, and a checker with no lock (one replica, as before) always writes.
func TestOnlyTheReplicaHoldingTheLockWritesTheHealthStatus(t *testing.T) {
	reg := &mockRegistry{clusters: map[cluster.ID]cluster.Info{}} // no cluster a: its probe fails
	for name, c := range map[string]struct {
		writer    statusWriter
		wantWrite bool
	}{
		"no lock":       {nil, true},
		"holds it":      {lockAnswer(true), true},
		"does not hold": {lockAnswer(false), false},
	} {
		svc := breakerService(t, reg, 5)
		rows := &healthRows{metas: []cluster.Meta{{ID: "a"}}, written: map[cluster.ID]string{}}
		hc := NewHealthChecker(svc, rows, 0)
		if c.writer != nil {
			hc.WriteStatusWhen(c.writer)
		}
		hc.sweep(context.Background())
		if !svc.ClusterDown("a") {
			t.Errorf("%s: the replica's own breaker did not open on a failed probe", name)
		}
		got, wrote := rows.written["a"]
		if wrote != c.wantWrite || (wrote && got != "disconnected") {
			t.Errorf("%s: written %q (%v), want a write %v", name, got, wrote, c.wantWrite)
		}
	}
}

// breakerService is newTestService with the breaker on, opening after fails live failures.
func breakerService(t *testing.T, reg cluster.Registry, fails int) *Service {
	t.Helper()
	s, err := NewService(context.Background(), reg, false, nil, ServiceOptions{MaxClusters: 20, BreakerFails: fails})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	return s
}

// MC_BREAKER_CONSECUTIVE_FAILS 0 is the breaker off: neither live failures nor a failed health check fail requests fast.
func TestBreakerWithZeroFailsIsOff(t *testing.T) {
	reg := &mockRegistry{clusters: map[cluster.ID]cluster.Info{}} // no cluster a: its probe fails
	svc := breakerService(t, reg, 0)
	for range 10 {
		svc.MarkClusterDown("a")
	}
	if svc.ClusterDown("a") {
		t.Error("live failures opened a breaker that is off")
	}
	rows := &healthRows{metas: []cluster.Meta{{ID: "a"}}, written: map[cluster.ID]string{}}
	NewHealthChecker(svc, rows, 0).sweep(context.Background())
	if svc.ClusterDown("a") {
		t.Error("a failed health check opened a breaker that is off")
	}
	if rows.written["a"] != "disconnected" {
		t.Errorf("the status written %q, want the check's answer still written", rows.written["a"])
	}
}

// With the clusters not listed (the database down) a sweep keeps the verdicts it had and says so once, with the time,
// and once more when the list is back.
func TestASweepThatCannotListKeepsTheVerdictsAndSaysSoOnce(t *testing.T) {
	logs := captureLogs(t)
	svc := breakerService(t, &mockRegistry{clusters: map[cluster.ID]cluster.Info{}}, 5)
	svc.health.setOpen("down", true)
	svc.MarkClusterDown("up")
	rows := &healthRows{metas: []cluster.Meta{{ID: "down"}, {ID: "up"}}, written: map[cluster.ID]string{}, listErr: errors.New("database down")}
	hc := NewHealthChecker(svc, rows, 0)
	count := func(lines, msg string) (n int) {
		for _, l := range strings.Split(lines, "\n") {
			if strings.Contains(l, msg) {
				n++
			}
		}
		return n
	}
	for range 3 {
		hc.sweep(context.Background())
	}
	got := logs.take()
	if !svc.ClusterDown("down") || svc.ClusterDown("up") {
		t.Errorf("verdicts changed while the list failed: down %v, up %v", svc.ClusterDown("down"), svc.ClusterDown("up"))
	}
	if n := count(got, "cannot list the clusters"); n != 1 || !strings.Contains(got, "level=WARN") || !strings.Contains(got, "since=") {
		t.Errorf("%d lines over three failed sweeps, want one warning with its time:\n%s", n, got)
	}
	if len(rows.written) != 0 {
		t.Errorf("statuses written without a list: %v", rows.written)
	}
	rows.listErr, rows.metas = nil, nil
	hc.sweep(context.Background())
	hc.sweep(context.Background())
	if n := count(logs.take(), "listing the clusters again"); n != 1 {
		t.Errorf("%d lines once the list is back, want one", n)
	}
	rows.listErr = errors.New("database down")
	hc.sweep(context.Background())
	if n := count(logs.take(), "cannot list the clusters"); n != 1 {
		t.Errorf("%d lines for a second outage, want one", n)
	}
}
