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
