// Package accessrequests ends temporary per-cluster grants on time.
//
// An approved access request turns the user's grant into one with expires_at.
// The token issuance queries already ignore an expired grant, so the next
// refresh would drop the role by itself; the sweeper makes it immediate — it
// restores the previous role (or removes the grant), closes the request and
// revokes the user's tokens — and records each reversal in the audit log as
// the system actor. It also lapses pending requests nobody reviewed within
// PendingTTL. Several auth-service replicas may run it at once: the row
// selection uses FOR UPDATE SKIP LOCKED.
package accessrequests

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// Audit actions written by the sweeper (docs/audit-log-plan.md §5-2).
const (
	ActionGrantExpire   = "access.grant.expire"
	ActionRequestExpire = "access.request.expire"
)

// PendingTTL is how long a request waits for a decision before it lapses.
const PendingTTL = 24 * time.Hour

// Store is the database side of the sweeper (repository.Repository).
type Store interface {
	ExpireGrants(ctx context.Context, now time.Time) ([]repository.ExpiredGrant, error)
	ExpirePendingRequests(ctx context.Context, before, now time.Time) ([]repository.LapsedRequest, error)
}

// Sweeper reverts expired grants and lapses stale requests.
type Sweeper struct {
	Store Store
	Audit audit.Writer // may be nil (tests)
	Now   func() time.Time
}

// Run sweeps once immediately and then every `every`, until ctx is done.
func Run(ctx context.Context, s Sweeper, every time.Duration) {
	s.RunOnce(ctx)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.RunOnce(ctx)
		}
	}
}

// Result counts what one sweep did.
type Result struct {
	GrantsExpired  int
	RequestsLapsed int
}

// RunOnce sweeps once; errors are logged, never fatal for the service.
func (s Sweeper) RunOnce(ctx context.Context) Result {
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	var res Result
	expired, err := s.Store.ExpireGrants(ctx, now)
	if err != nil {
		slog.Error("access requests: expiring grants failed", "error", err)
	}
	for _, g := range expired {
		res.GrantsExpired++
		after := map[string]any{"role": g.Role, "restored_role": g.RestoredRole, "request_id": g.RequestID}
		s.record(ctx, ActionGrantExpire, g.UserID, g.UserEmail, g.ClusterID, after)
		slog.Info("access requests: grant expired", "user", g.UserEmail, "cluster", g.ClusterID, "role", g.Role)
	}
	lapsed, err := s.Store.ExpirePendingRequests(ctx, now.Add(-PendingTTL), now)
	if err != nil {
		slog.Error("access requests: lapsing pending requests failed", "error", err)
	}
	for _, l := range lapsed {
		res.RequestsLapsed++
		after := map[string]any{"request_id": l.ID, "role": l.Role, "end_reason": repository.EndReasonNotReviewed}
		s.record(ctx, ActionRequestExpire, l.UserID, l.UserEmail, l.ClusterID, after)
	}
	return res
}

func (s Sweeper) record(ctx context.Context, action, userID, email, clusterID string, after map[string]any) {
	if s.Audit == nil {
		return
	}
	raw, _ := json.Marshal(after)
	rec := audit.Record{
		Service:     audit.ServiceAuth,
		Action:      action,
		ActorUserID: "system",
		ActorEmail:  "system",
		TargetType:  "user",
		TargetID:    userID,
		TargetEmail: email,
		Cluster:     clusterID,
		After:       raw,
		Result:      audit.ResultSuccess,
	}
	if _, err := s.Audit.Write(ctx, rec); err != nil {
		slog.Error("access requests: audit write failed", "action", action, "error", err)
	}
}
