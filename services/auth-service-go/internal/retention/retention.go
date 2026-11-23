// Package retention deletes rows whose retention period has passed.
//
// auth-service owns the schema, so it also owns retention. Two independent
// windows, both in days and both off (0) by default:
//
//   - AuditDays: auth_audit_logs older than the cutoff. The stdout copy of
//     every record (services/pkg/audit StdoutTee) lives in the cluster log
//     pipeline with its own retention, so the database is not the only copy.
//   - ChatDays: AI chat sessions by last activity (sessions.updated_at) with
//     their messages, session_contexts and tool approvals, and tool approval
//     requests by created_at (their decisions are already in the audit log as
//     ai.tool.approve / ai.tool.reject; one deleted while still approved had
//     no outcome of its call written, and the run's record names it in
//     open_approvals).
//
// Deletes run in batches so a first purge on an old database does not hold a
// long lock; PostgreSQL's autovacuum reclaims the space for reuse. Each window
// runs whether or not one before it failed. Every run is recorded as an audit
// record admin.retention.purge (actor "system") naming the windows that failed.
package retention

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// Action is the audit action written for every purge run.
const Action = "admin.retention.purge"

// BatchSize bounds one DELETE statement.
const BatchSize = 5000

// Config is the retention policy. Zero means keep forever. ReviewDays covers
// sign-offs with their snapshots: access reviews (access_reviews) and cluster
// hygiene reviews (hygiene_reviews). InvestigationDays covers the alert
// investigation reports (alert_investigations), which can quote pod logs, and
// the alert inbox rows (alert_inbox) by the last notification.
type Config struct {
	AuditDays         int
	ChatDays          int
	ReviewDays        int
	InvestigationDays int
}

// Enabled reports whether any window is set.
func (c Config) Enabled() bool {
	return c.AuditDays > 0 || c.ChatDays > 0 || c.ReviewDays > 0 || c.InvestigationDays > 0
}

// Validate rejects negative windows.
func (c Config) Validate() error {
	if c.AuditDays < 0 || c.ChatDays < 0 || c.ReviewDays < 0 || c.InvestigationDays < 0 {
		return fmt.Errorf("retention: days must be 0 or positive (audit=%d chat=%d review=%d investigation=%d)", c.AuditDays, c.ChatDays, c.ReviewDays, c.InvestigationDays)
	}
	return nil
}

// ReviewCutoff returns the timestamp before which sign-offs are deleted (zero when off).
// Every cut-off is in UTC, as the TIMESTAMP columns it is compared with hold it.
func (c Config) ReviewCutoff(now time.Time) time.Time {
	if c.ReviewDays > 0 {
		return now.UTC().AddDate(0, 0, -c.ReviewDays)
	}
	return time.Time{}
}

// InvestigationCutoff returns the timestamp before which alert investigations
// are deleted (zero when off).
func (c Config) InvestigationCutoff(now time.Time) time.Time {
	if c.InvestigationDays > 0 {
		return now.UTC().AddDate(0, 0, -c.InvestigationDays)
	}
	return time.Time{}
}

// Cutoffs returns the timestamps before which rows are deleted (zero when off).
func (c Config) Cutoffs(now time.Time) (audit, chat time.Time) {
	if c.AuditDays > 0 {
		audit = now.UTC().AddDate(0, 0, -c.AuditDays)
	}
	if c.ChatDays > 0 {
		chat = now.UTC().AddDate(0, 0, -c.ChatDays)
	}
	return audit, chat
}

// Result counts what one run deleted.
type Result struct {
	AuditRows         int64 `json:"audit_rows"`
	Sessions          int64 `json:"sessions"`
	ToolApprovals     int64 `json:"tool_approvals"`
	SessionRecordings int64 `json:"session_recordings"` // index rows (and database-stored parts); objects in S3/files are the store's to expire
	AccessReviews     int64 `json:"access_reviews"`
	HygieneReviews    int64 `json:"hygiene_reviews"`
	Investigations    int64 `json:"alert_investigations"`
	InboxAlerts       int64 `json:"alert_inbox"`
	// the tool approvals deleted while still approved: no outcome of their calls had been written
	OpenApprovals []OpenApproval `json:"open_approvals,omitempty"`
}

// OpenApproval names a tool approval by ids and names only, never the call's arguments.
type OpenApproval struct {
	ID         string     `json:"id"`
	SessionID  string     `json:"session_id"`
	Tool       string     `json:"tool"`
	Cluster    string     `json:"cluster"`
	ApprovedAt *time.Time `json:"approved_at"`
}

// DB is what the purge uses of the database: the service's *pgxpool.Pool.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Purger executes the policy against a database.
type Purger struct {
	Pool  DB
	Cfg   Config
	Audit audit.Writer // may be nil (tests)
	Now   func() time.Time
	// AuditFloor, when set, caps audit deletion at the highest id every audit
	// sink has sent (auditsink.Floor): rows a sink has not copied out yet stay
	// past their window.
	AuditFloor func(ctx context.Context) (int64, error)
}

// Run purges once immediately and then every `every`, until ctx is done. Each
// run is a turn taken through lock (turn): of several replicas one purges at a
// time, and a replica whose turn comes while another's run goes leaves it.
func Run(ctx context.Context, p Purger, lock Locker, every time.Duration) {
	if !p.Cfg.Enabled() {
		return
	}
	p.turn(ctx, lock)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.turn(ctx, lock)
		}
	}
}

// RunOnce purges once and records the run in the audit log; errors are logged,
// never fatal for the service. It takes no lock: Run calls it through turn.
func (p Purger) RunOnce(ctx context.Context) Result {
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}
	res, failed, err := p.purge(ctx, now)
	if err != nil {
		slog.Error("retention: purge failed", "error", err, "failed_windows", failed, "deleted", res)
	} else {
		slog.Info("retention: purge done", "audit_rows", res.AuditRows, "sessions", res.Sessions, "tool_approvals", res.ToolApprovals, "session_recordings", res.SessionRecordings,
			"access_reviews", res.AccessReviews, "hygiene_reviews", res.HygieneReviews, "alert_investigations", res.Investigations, "alert_inbox", res.InboxAlerts,
			"audit_days", p.Cfg.AuditDays, "chat_days", p.Cfg.ChatDays, "review_days", p.Cfg.ReviewDays, "investigation_days", p.Cfg.InvestigationDays)
	}
	p.record(ctx, now, res, failed, err)
	return res
}

// Purge deletes everything older than the configured windows as of now. The
// windows run apart: the error joins those of the windows that failed, and a
// window after a failed one still runs.
func (p Purger) Purge(ctx context.Context, now time.Time) (Result, error) {
	res, _, err := p.purge(ctx, now)
	return res, err
}

// purge is Purge that also names the windows that failed, in the order they ran.
func (p Purger) purge(ctx context.Context, now time.Time) (res Result, failed []string, err error) {
	if err := p.Cfg.Validate(); err != nil {
		return res, nil, err
	}
	if !p.Cfg.Enabled() {
		return res, nil, nil
	}
	if p.Pool == nil {
		return res, nil, errors.New("retention: no database pool")
	}
	auditCutoff, chatCutoff := p.Cfg.Cutoffs(now)
	var errs []error
	for _, w := range []struct {
		name   string
		cutoff time.Time
		purge  func(context.Context, time.Time, *Result) error
	}{
		{"audit", auditCutoff, p.purgeAudit},
		{"chat", chatCutoff, p.purgeChat},
		{"review", p.Cfg.ReviewCutoff(now), p.purgeReviews},
		{"investigation", p.Cfg.InvestigationCutoff(now), p.purgeInvestigations},
	} {
		if w.cutoff.IsZero() {
			continue
		}
		if err := w.purge(ctx, w.cutoff, &res); err != nil {
			failed = append(failed, w.name)
			errs = append(errs, err)
		}
	}
	return res, failed, errors.Join(errs...)
}

func (p Purger) purgeAudit(ctx context.Context, cutoff time.Time, res *Result) error {
	// Only the prefix of the hash chain goes: a row sealed after newer rows
	// (chain_seq above the oldest kept one) stays until the chain reaches it,
	// so the kept range verifies without a gap (internal/auditchain).
	var minKept int64
	if err := p.Pool.QueryRow(ctx, `SELECT COALESCE(MIN(chain_seq), 9223372036854775807) FROM auth_audit_logs WHERE created_at >= $1`, cutoff).Scan(&minKept); err != nil {
		return fmt.Errorf("audit log: chain floor: %w", err)
	}
	var err error
	if p.AuditFloor != nil {
		floor, ferr := p.AuditFloor(ctx)
		if ferr != nil {
			return fmt.Errorf("audit log: sink floor: %w", ferr)
		}
		res.AuditRows, err = deleteBatched(ctx, p.Pool,
			`DELETE FROM auth_audit_logs WHERE id IN (SELECT id FROM auth_audit_logs WHERE created_at < $1 AND id <= $3 AND (chain_seq IS NULL OR chain_seq < $4) ORDER BY id LIMIT $2)`, cutoff, floor, minKept)
	} else {
		res.AuditRows, err = deleteBatched(ctx, p.Pool,
			`DELETE FROM auth_audit_logs WHERE id IN (SELECT id FROM auth_audit_logs WHERE created_at < $1 AND (chain_seq IS NULL OR chain_seq < $3) ORDER BY id LIMIT $2)`, cutoff, minKept)
	}
	if err != nil {
		return fmt.Errorf("audit log: %w", err)
	}
	// Terminal recordings follow the audit window; finished ones only.
	res.SessionRecordings, err = deleteBatched(ctx, p.Pool,
		`DELETE FROM session_recordings WHERE id IN (SELECT id FROM session_recordings WHERE started_at < $1 AND status IN ('uploaded', 'interrupted') ORDER BY started_at LIMIT $2)`, cutoff)
	if err != nil {
		return fmt.Errorf("session recordings: %w", err)
	}
	return nil
}

func (p Purger) purgeChat(ctx context.Context, cutoff time.Time, res *Result) error {
	n, err := deleteApprovalsBatched(ctx, p.Pool, res,
		`DELETE FROM tool_approvals WHERE id IN (SELECT id FROM tool_approvals WHERE created_at < $1 ORDER BY id LIMIT $2)`+approvalReturning, cutoff)
	if err != nil {
		return fmt.Errorf("tool approvals: %w", err)
	}
	res.ToolApprovals += n
	sessions, approvals, err := deleteExpiredSessions(ctx, p.Pool, res, cutoff)
	res.Sessions += sessions
	res.ToolApprovals += approvals
	if err != nil {
		return fmt.Errorf("sessions: %w", err)
	}
	return nil
}

func (p Purger) purgeReviews(ctx context.Context, cutoff time.Time, res *Result) error {
	var err error
	res.AccessReviews, err = deleteBatched(ctx, p.Pool,
		`DELETE FROM access_reviews WHERE id IN (SELECT id FROM access_reviews WHERE reviewed_at < $1 ORDER BY reviewed_at LIMIT $2)`, cutoff)
	if err != nil {
		return fmt.Errorf("access reviews: %w", err)
	}
	res.HygieneReviews, err = deleteBatched(ctx, p.Pool,
		`DELETE FROM hygiene_reviews WHERE id IN (SELECT id FROM hygiene_reviews WHERE reviewed_at < $1 ORDER BY reviewed_at LIMIT $2)`, cutoff)
	if err != nil {
		return fmt.Errorf("hygiene reviews: %w", err)
	}
	return nil
}

func (p Purger) purgeInvestigations(ctx context.Context, cutoff time.Time, res *Result) error {
	var err error
	res.Investigations, err = deleteBatched(ctx, p.Pool,
		`DELETE FROM alert_investigations WHERE id IN (SELECT id FROM alert_investigations WHERE received_at < $1 ORDER BY received_at LIMIT $2)`, cutoff)
	if err != nil {
		return fmt.Errorf("alert investigations: %w", err)
	}
	res.InboxAlerts, err = deleteBatched(ctx, p.Pool,
		`DELETE FROM alert_inbox WHERE id IN (SELECT id FROM alert_inbox WHERE last_received_at < $1 ORDER BY last_received_at LIMIT $2)`, cutoff)
	if err != nil {
		return fmt.Errorf("alert inbox: %w", err)
	}
	return nil
}

// deleteBatched repeats a batched DELETE until it deletes nothing.
func deleteBatched(ctx context.Context, db DB, sql string, cutoff time.Time, extra ...any) (int64, error) {
	var total int64
	args := append([]any{cutoff, BatchSize}, extra...)
	for {
		tag, err := db.Exec(ctx, sql, args...)
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < BatchSize {
			return total, nil
		}
	}
}

// expiredSessionStatements delete a batch of conversations ($1, their ids), the rows that name them first:
// tool_approvals reference sessions without ON DELETE CASCADE, and tables the SQLAlchemy ORM created before the
// migrations lack it on messages and session_contexts too (as session-service's DeleteSession). The tool_approvals
// statement is first and the sessions one last, as deleteSessionBatch counts them.
var expiredSessionStatements = []string{
	`DELETE FROM tool_approvals WHERE session_id = ANY($1)`,
	`DELETE FROM session_contexts WHERE session_id = ANY($1)`,
	`DELETE FROM messages WHERE session_id = ANY($1)`,
	`DELETE FROM sessions WHERE id = ANY($1)`,
}

// deleteExpiredSessions deletes the conversations last active before cutoff, BatchSize at a time.
func deleteExpiredSessions(ctx context.Context, db DB, res *Result, cutoff time.Time) (sessions, approvals int64, err error) {
	for {
		taken, s, a, err := deleteSessionBatch(ctx, db, res, cutoff)
		sessions += s
		approvals += a
		if err != nil || taken < BatchSize {
			return sessions, approvals, err
		}
	}
}

// deleteSessionBatch deletes one batch in one transaction. Its sessions are locked first, so no row naming one is
// added before it goes, whether or not the tables cascade. The tool approvals' delete returns its rows
// (approvalReturning); those deleted while approved go to res.OpenApprovals once the batch has committed.
func deleteSessionBatch(ctx context.Context, db DB, res *Result, cutoff time.Time) (taken int, sessions, approvals int64, err error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return 0, 0, 0, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id FROM sessions WHERE updated_at < $1 ORDER BY updated_at LIMIT $2 FOR UPDATE`, cutoff, BatchSize)
	if err != nil {
		return 0, 0, 0, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(ids) == 0 {
		return 0, 0, 0, err
	}
	deleted := make([]int64, len(expiredSessionStatements))
	var open []OpenApproval
	for i, stmt := range expiredSessionStatements {
		if i == 0 {
			rows, err := tx.Query(ctx, stmt+approvalReturning, ids)
			if err != nil {
				return 0, 0, 0, err
			}
			if deleted[i], open, err = readApprovals(rows); err != nil {
				return 0, 0, 0, err
			}
			continue
		}
		tag, err := tx.Exec(ctx, stmt, ids)
		if err != nil {
			return 0, 0, 0, err
		}
		deleted[i] = tag.RowsAffected()
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, 0, err
	}
	res.OpenApprovals = append(res.OpenApprovals, open...)
	return len(ids), deleted[len(deleted)-1], deleted[0], nil
}

// approvalReturning returns each tool approval as it was deleted, after any write to it that committed first.
const approvalReturning = ` RETURNING id, session_id, tool, cluster, status, decided_at`

// deleteApprovalsBatched is deleteBatched for tool approvals: it adds those deleted while approved to res.OpenApprovals.
func deleteApprovalsBatched(ctx context.Context, db DB, res *Result, sql string, cutoff time.Time) (int64, error) {
	var total int64
	for {
		rows, err := db.Query(ctx, sql, cutoff, BatchSize)
		if err != nil {
			return total, err
		}
		n, open, err := readApprovals(rows)
		if err != nil {
			return total, err
		}
		total += n
		res.OpenApprovals = append(res.OpenApprovals, open...)
		if n < BatchSize {
			return total, nil
		}
	}
}

// readApprovals reads the rows of a tool approvals' delete with approvalReturning: how many it deleted, and those
// deleted while approved.
func readApprovals(rows pgx.Rows) (n int64, open []OpenApproval, err error) {
	for rows.Next() {
		var a OpenApproval
		var status string
		if err := rows.Scan(&a.ID, &a.SessionID, &a.Tool, &a.Cluster, &status, &a.ApprovedAt); err != nil {
			rows.Close()
			return 0, nil, err
		}
		n++
		if status == "approved" {
			open = append(open, a)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	return n, open, nil
}

func (p Purger) record(ctx context.Context, now time.Time, res Result, failed []string, runErr error) {
	if p.Audit == nil {
		return
	}
	if failed == nil {
		failed = []string{}
	}
	auditCutoff, chatCutoff := p.Cfg.Cutoffs(now)
	fields := map[string]any{
		"audit_days":           p.Cfg.AuditDays,
		"chat_days":            p.Cfg.ChatDays,
		"audit_cutoff":         nullableTime(auditCutoff),
		"chat_cutoff":          nullableTime(chatCutoff),
		"audit_rows":           res.AuditRows,
		"sessions":             res.Sessions,
		"tool_approvals":       res.ToolApprovals,
		"session_recordings":   res.SessionRecordings,
		"review_days":          p.Cfg.ReviewDays,
		"review_cutoff":        nullableTime(p.Cfg.ReviewCutoff(now)),
		"access_reviews":       res.AccessReviews,
		"hygiene_reviews":      res.HygieneReviews,
		"investigation_days":   p.Cfg.InvestigationDays,
		"alert_investigations": res.Investigations,
		"alert_inbox":          res.InboxAlerts,
		"failed_windows":       failed,
	}
	if len(res.OpenApprovals) > 0 {
		fields["open_approvals"] = res.OpenApprovals
	}
	after, _ := json.Marshal(fields)
	rec := audit.Record{
		Service:    audit.ServiceAdmin,
		Action:     Action,
		ActorEmail: "system",
		TargetType: "retention",
		TargetID:   "database",
		After:      audit.MaskSensitive(after),
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
