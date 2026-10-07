// Package dormant locks accounts nobody has used for a while.
//
// An account with no sign-in and no API key use for Days days (creation
// counts as the first activity) gets dormant_locked_at set and its tokens
// revoked; password login, OIDC login and API key exchange then refuse it
// until an admin unlocks it. Each lock is recorded in the audit log as the
// system actor. Accounts whose global role carries "*" or admin.* are
// exempt when ExemptAdmins is set, so the last administrator cannot lock
// everyone out. Several auth-service replicas may run it at once: the row
// selection uses FOR UPDATE SKIP LOCKED.
package dormant

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// ActionLock is the audit action written for every account locked
// (docs/audit-log-plan.md §5-2).
const ActionLock = "user.account.dormant_lock"

// Store is the database side of the sweeper (repository.Repository).
type Store interface {
	LockDormantAccounts(ctx context.Context, cutoff, now time.Time, exemptAdmins bool) ([]repository.DormantLocked, error)
}

// Sweeper locks dormant accounts.
type Sweeper struct {
	Store        Store
	Audit        audit.Writer // may be nil (tests)
	Now          func() time.Time
	Days         int
	ExemptAdmins bool
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

// Result is what one sweep did.
type Result struct {
	Locked []repository.DormantLocked `json:"locked"`
	Cutoff time.Time                  `json:"cutoff"`
	Err    error                      `json:"-"`
}

// RunOnce sweeps once; errors are logged, never fatal for the service.
func (s Sweeper) RunOnce(ctx context.Context) Result {
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	res := Result{Cutoff: now.AddDate(0, 0, -s.Days).UTC(), Locked: []repository.DormantLocked{}}
	if s.Days <= 0 {
		return res
	}
	locked, err := s.Store.LockDormantAccounts(ctx, res.Cutoff, now, s.ExemptAdmins)
	if err != nil {
		slog.Error("dormant accounts: lock failed", "error", err)
		res.Err = err
		return res
	}
	for _, d := range locked {
		res.Locked = append(res.Locked, d)
		s.record(ctx, d)
		slog.Info("dormant accounts: locked", "user", d.Email, "last_activity", d.LastActivity.UTC().Format(time.RFC3339), "days", s.Days)
	}
	return res
}

func (s Sweeper) record(ctx context.Context, d repository.DormantLocked) {
	if s.Audit == nil {
		return
	}
	raw, _ := json.Marshal(map[string]any{"last_activity": d.LastActivity.UTC().Format(time.RFC3339), "days": s.Days, "exempt_admins": s.ExemptAdmins})
	rec := audit.Record{
		Service:     audit.ServiceAuth,
		Action:      ActionLock,
		ActorUserID: "system",
		ActorEmail:  "system",
		TargetType:  "user",
		TargetID:    d.UserID,
		TargetEmail: d.Email,
		After:       raw,
		Result:      audit.ResultSuccess,
	}
	if _, err := s.Audit.Write(ctx, rec); err != nil {
		slog.Error("dormant accounts: audit write failed", "error", err)
	}
}
