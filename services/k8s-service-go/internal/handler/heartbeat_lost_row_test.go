package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nodeshells"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// outageAudit is lockedAudit refusing rows while down.
type outageAudit struct {
	lockedAudit
	down atomic.Bool
}

func (a *outageAudit) Write(ctx context.Context, rec audit.Record) (int64, error) {
	if a.down.Load() {
		return 0, errors.New("dial tcp: i/o timeout")
	}
	return a.lockedAudit.Write(ctx, rec)
}

// A node shell closed for heartbeat_lost while the database is out gets its k8s.session.end row once the database is
// back, with the opening request's actor and when the shell closed (ended_at), written by the node shells' tracker.
func TestAHeartbeatLostRowTheDatabaseDidNotTakeIsWrittenOnceItIsBack(t *testing.T) {
	store := nodeshells.NewMemory(nil)
	rows := &outageAudit{}
	tracker := nodeshells.NewTracker(store, func(context.Context, nodeshells.Row) (bool, error) { return false, nil }, rows, time.Hour).
		WithTimes(10*time.Millisecond, time.Hour, time.Hour)
	h := &Handler{auditStore: rows}
	h.SetNodeShells(tracker)

	ctx := cluster.WithID(auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Email: "u1@example.com"}), "c")
	r := httptest.NewRequest(http.MethodGet, "/api/v1/nodes/n1/debug-shell/ws", nil).WithContext(ctx)
	shellCtx, stopShell := context.WithCancelCause(ctx)
	stopShell(nodeshells.ErrHeartbeatLost)

	rows.down.Store(true)
	store.SetFail(errors.New("dial tcp: i/o timeout"))
	closedAt := time.Now().UTC()
	h.auditSessionEnd(shellCtx, r, "node", "n1", nodeShellTestNamespace, "node-shell")
	if tracker.Owed() != 1 {
		t.Fatalf("owed %d, want the row kept while the database is out", tracker.Owed())
	}

	runCtx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); tracker.Run(runCtx) }()
	t.Cleanup(func() { stop(); <-done })
	time.Sleep(30 * time.Millisecond) // beats while the database is out write nothing
	rows.down.Store(false)
	store.SetFail(nil)
	after := rows.sessionEndRow(t)
	if after["reason"] != nodeshells.ReasonHeartbeatLost || after["stream"] != "node-shell" {
		t.Fatalf("after %v", after)
	}
	ended, err := time.Parse(time.RFC3339Nano, after["ended_at"].(string))
	if err != nil || ended.Before(closedAt.Add(-time.Second)) || ended.After(closedAt.Add(time.Second)) {
		t.Fatalf("ended_at %v (%v), want about %s, when the shell closed", after["ended_at"], err, closedAt)
	}
	rows.mu.Lock()
	n, row := len(rows.rows), rows.rows[0]
	rows.mu.Unlock()
	if n != 1 || row.ActorUserID != "u1" || row.Cluster != "c" || row.TargetID != "n1" || row.Result != audit.ResultSuccess {
		t.Fatalf("rows %d, first %+v: want one row with the opener and the node", n, row)
	}
}

// Without a tracker the handler writes the heartbeat_lost row itself, with ended_at.
func TestAHeartbeatLostRowWithoutATrackerIsWrittenByTheHandler(t *testing.T) {
	store := &lockedAudit{}
	h := &Handler{auditStore: store}
	ctx := cluster.WithID(auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1"}), "c")
	r := httptest.NewRequest(http.MethodGet, "/api/v1/nodes/n1/debug-shell/ws", nil).WithContext(ctx)
	shellCtx, stopShell := context.WithCancelCause(ctx)
	stopShell(nodeshells.ErrHeartbeatLost)
	h.auditSessionEnd(shellCtx, r, "node", "n1", nodeShellTestNamespace, "node-shell")
	if after := store.sessionEndRow(t); after["reason"] != nodeshells.ReasonHeartbeatLost || after["ended_at"] == nil {
		t.Fatalf("after %v", after)
	}
}
