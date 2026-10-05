// Package retention deletes rows whose retention period has passed.
//
// auth-service owns the schema, so it also owns retention. Two independent
// windows, both in days and both off (0) by default:
//
//   - AuditDays: auth_audit_logs older than the cutoff. The stdout copy of
//     every record (services/pkg/audit StdoutTee) lives in the cluster log
//     pipeline with its own retention, so the database is not the only copy.
//   - ChatDays: AI chat sessions by last activity (sessions.updated_at) with
//     their messages and session_contexts (FK ON DELETE CASCADE), and tool
//     approval requests by created_at (their decisions are already in the
//     audit log as ai.tool.approve / ai.tool.reject).
//
// Deletes run in batches so a first purge on an old database does not hold a
// long lock; PostgreSQL's autovacuum reclaims the space for reuse. Every run is
// recorded as an audit record admin.retention.purge (actor "system").
package retention

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// Action is the audit action written for every purge run.
const Action = "admin.retention.purge"

// BatchSize bounds one DELETE statement.
const BatchSize = 5000

// Config is the retention policy. Zero means keep forever.
type Config struct {
	AuditDays int
	ChatDays  int
}

// Enabled reports whether any window is set.
func (c Config) Enabled() bool { return c.AuditDays > 0 || c.ChatDays > 0 }

// Validate rejects negative windows.
func (c Config) Validate() error {
	if c.AuditDays < 0 || c.ChatDays < 0 {
		return fmt.Errorf("retention: days must be 0 or positive (audit=%d chat=%d)", c.AuditDays, c.ChatDays)
	}
	return nil
}

// Cutoffs returns the timestamps before which rows are deleted (zero when off).
func (c Config) Cutoffs(now time.Time) (audit, chat time.Time) {
	if c.AuditDays > 0 {
		audit = now.AddDate(0, 0, -c.AuditDays)
	}
	if c.ChatDays > 0 {
		chat = now.AddDate(0, 0, -c.ChatDays)
	}
	return audit, chat
}

// Result counts what one run deleted.
type Result struct {
	AuditRows         int64 `json:"audit_rows"`
	Sessions          int64 `json:"sessions"`
	ToolApprovals     int64 `json:"tool_approvals"`
	SessionRecordings int64 `json:"session_recordings"` // index rows (and database-stored parts); objects in S3/files are the store's to expire
}

// Purger executes the policy against a database.
type Purger struct {
	Pool  *pgxpool.Pool
	Cfg   Config
	Audit audit.Writer // may be nil (tests)
	Now   func() time.Time
	// AuditFloor, when set, caps audit deletion at the highest id every audit
	// sink has sent (auditsink.Floor): rows a sink has not copied out yet stay
	// past their window.
	AuditFloor func(ctx context.Context) (int64, error)
}

// Run purges once immediately and then every `every`, until ctx is done.
func Run(ctx context.Context, p Purger, every time.Duration) {
	if !p.Cfg.Enabled() {
		return
	}
	p.RunOnce(ctx)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.RunOnce(ctx)
		}
	}
}

// RunOnce purges once and records the run in the audit log; errors are logged,
// never fatal for the service.
func (p Purger) RunOnce(ctx context.Context) Result {
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}
	res, err := p.Purge(ctx, now)
	if err != nil {
		slog.Error("retention: purge failed", "error", err, "deleted", res)
	} else {
		slog.Info("retention: purge done", "audit_rows", res.AuditRows, "sessions", res.Sessions, "tool_approvals", res.ToolApprovals, "session_recordings", res.SessionRecordings,
			"audit_days", p.Cfg.AuditDays, "chat_days", p.Cfg.ChatDays)
	}
	p.record(ctx, now, res, err)
	return res
}

// Purge deletes everything older than the configured windows as of now.
func (p Purger) Purge(ctx context.Context, now time.Time) (Result, error) {
	var res Result
	if err := p.Cfg.Validate(); err != nil {
		return res, err
	}
	if !p.Cfg.Enabled() {
		return res, nil
	}
	if p.Pool == nil {
		return res, errors.New("retention: no database pool")
	}
	auditCutoff, chatCutoff := p.Cfg.Cutoffs(now)
	var err error
	if !auditCutoff.IsZero() {
		if p.AuditFloor != nil {
			floor, ferr := p.AuditFloor(ctx)
			if ferr != nil {
				return res, fmt.Errorf("audit log: sink floor: %w", ferr)
			}
			res.AuditRows, err = deleteBatched(ctx, p.Pool,
				`DELETE FROM auth_audit_logs WHERE id IN (SELECT id FROM auth_audit_logs WHERE created_at < $1 AND id <= $3 ORDER BY id LIMIT $2)`, auditCutoff, floor)
		} else {
			res.AuditRows, err = deleteBatched(ctx, p.Pool,
				`DELETE FROM auth_audit_logs WHERE id IN (SELECT id FROM auth_audit_logs WHERE created_at < $1 ORDER BY id LIMIT $2)`, auditCutoff)
		}
		if err != nil {
			return res, fmt.Errorf("audit log: %w", err)
		}
		// Terminal recordings follow the audit window; finished ones only.
		res.SessionRecordings, err = deleteBatched(ctx, p.Pool,
			`DELETE FROM session_recordings WHERE id IN (SELECT id FROM session_recordings WHERE started_at < $1 AND status IN ('uploaded', 'interrupted') ORDER BY started_at LIMIT $2)`, auditCutoff)
		if err != nil {
			return res, fmt.Errorf("session recordings: %w", err)
		}
	}
	if !chatCutoff.IsZero() {
		// tool_approvals reference sessions without ON DELETE CASCADE: drop the
		// old ones and the ones whose session is about to go, then the sessions
		// (messages and session_contexts cascade).
		n, err := deleteBatched(ctx, p.Pool,
			`DELETE FROM tool_approvals WHERE id IN (SELECT id FROM tool_approvals WHERE created_at < $1 ORDER BY id LIMIT $2)`, chatCutoff)
		if err != nil {
			return res, fmt.Errorf("tool approvals: %w", err)
		}
		res.ToolApprovals += n
		n, err = deleteBatched(ctx, p.Pool,
			`DELETE FROM tool_approvals WHERE id IN (SELECT t.id FROM tool_approvals t JOIN sessions s ON s.id = t.session_id WHERE s.updated_at < $1 ORDER BY t.id LIMIT $2)`, chatCutoff)
		if err != nil {
			return res, fmt.Errorf("tool approvals of expired sessions: %w", err)
		}
		res.ToolApprovals += n
		res.Sessions, err = deleteBatched(ctx, p.Pool,
			`DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE updated_at < $1 ORDER BY updated_at LIMIT $2)`, chatCutoff)
		if err != nil {
			return res, fmt.Errorf("sessions: %w", err)
		}
	}
	return res, nil
}

// deleteBatched repeats a batched DELETE until it deletes nothing.
func deleteBatched(ctx context.Context, pool *pgxpool.Pool, sql string, cutoff time.Time, extra ...any) (int64, error) {
	var total int64
	args := append([]any{cutoff, BatchSize}, extra...)
	for {
		tag, err := pool.Exec(ctx, sql, args...)
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < BatchSize {
			return total, nil
		}
	}
}

func (p Purger) record(ctx context.Context, now time.Time, res Result, runErr error) {
	if p.Audit == nil {
		return
	}
	auditCutoff, chatCutoff := p.Cfg.Cutoffs(now)
	after, _ := json.Marshal(map[string]any{
		"audit_days":         p.Cfg.AuditDays,
		"chat_days":          p.Cfg.ChatDays,
		"audit_cutoff":       nullableTime(auditCutoff),
		"chat_cutoff":        nullableTime(chatCutoff),
		"audit_rows":         res.AuditRows,
		"sessions":           res.Sessions,
		"tool_approvals":     res.ToolApprovals,
		"session_recordings": res.SessionRecordings,
	})
	rec := audit.Record{
		Service:    audit.ServiceAdmin,
		Action:     Action,
		ActorEmail: "system",
		TargetType: "retention",
		TargetID:   "database",
		After:      after,
		Result:     audit.ResultSuccess,
	}
	if runErr != nil {
		rec.Result = audit.ResultFailure
		rec.Error = runErr.Error()
	}
	if _, err := p.Audit.Write(ctx, rec); err != nil {
		slog.Error("retention: audit write failed", "error", err)
	}
}

func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}
