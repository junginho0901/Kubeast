package main

import (
	"context"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nodeshells"
)

// With node shell off (the default) no server gets a tracker, so none beats or sweeps; with it on, the servers that
// open terminals do and an api-only server does not.
func TestNodeShellRowsRunOnlyWhereNodeShellsOpen(t *testing.T) {
	store := nodeshells.NewMemory(nil)
	remove := func(context.Context, nodeshells.Row) (bool, error) { return false, nil }
	for _, c := range []struct {
		enabled bool
		role    config.Role
		want    bool
	}{
		{false, config.RoleAll, false},
		{false, config.RoleStream, false},
		{false, config.RoleAPI, false},
		{true, config.RoleAll, true},
		{true, config.RoleStream, true},
		{true, config.RoleAPI, false},
	} {
		if got := nodeShellTracker(c.enabled, c.role, store, remove, nil, time.Hour) != nil; got != c.want {
			t.Errorf("node shell %v, role %s: tracker %v, want %v", c.enabled, c.role, got, c.want)
		}
	}
}

type idleCount struct{ n int }

func (i *idleCount) Idle() { i.n++ }

// At shutdown the tracker's context ends and the heartbeat's connection goes back to the pool right away, before the
// pool's Close (registered first, so it runs last), and nothing is waited for.
func TestStopNodeShellsEndsTheTrackerAndGivesItsConnectionBack(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	store := &idleCount{}
	start := time.Now()
	stopNodeShells(cancel, store)
	if ctx.Err() == nil || store.n != 1 {
		t.Fatalf("context %v, Idle calls %d; want cancelled and 1", ctx.Err(), store.n)
	}
	if d := time.Since(start); d > 100*time.Millisecond {
		t.Fatalf("stopNodeShells took %s, want no wait", d)
	}
}
