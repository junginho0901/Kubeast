package k8s

import (
	"context"
	"sync"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// healthRows is the registry side of the checker: the clusters it lists and the statuses written.
type healthRows struct {
	mu      sync.Mutex
	metas   []cluster.Meta
	written map[cluster.ID]string
}

func (h *healthRows) ListMeta(context.Context) ([]cluster.Meta, error) { return h.metas, nil }

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
		svc := newTestService(t, reg)
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
