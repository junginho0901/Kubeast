package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore implements Writer and Reader against the shared
// `auth_audit_logs` table.
type PostgresStore struct {
	pool           *pgxpool.Pool
	defaultService string // fallback when Record.Service is empty
	defaultCluster string // fallback when Record.Cluster is empty
}

// NewPostgresStore creates a PostgresStore. The defaultService is used as
// Record.Service when the caller leaves it empty (e.g. "auth" inside
// auth-service, "k8s" inside k8s-service-go).
func NewPostgresStore(pool *pgxpool.Pool, defaultService string) *PostgresStore {
	return &PostgresStore{
		pool:           pool,
		defaultService: defaultService,
		defaultCluster: "default",
	}
}

// EnsureSchema adds the v1.1 columns and indexes to an existing
// auth_audit_logs table. Safe to run repeatedly.
//
// Columns added: service, cluster, namespace, target_type, result, error.
// Indexes added: created_at DESC, action, actor_user_id, service.
func (s *PostgresStore) EnsureSchema(ctx context.Context) error {
	stmts := []string{
		`ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS service     VARCHAR`,
		`ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS cluster     VARCHAR`,
		`ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS namespace   VARCHAR`,
		`ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS target_type VARCHAR`,
		// Generic target identifier for non-user resources (pod/deployment/
		// release/...). target_user_id stays dedicated to auth-domain rows.
		`ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS target_id   VARCHAR`,
		`ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS result      VARCHAR NOT NULL DEFAULT 'success'`,
		`ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS error       TEXT`,
		`CREATE INDEX IF NOT EXISTS idx_audit_created_at ON auth_audit_logs (created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_action     ON auth_audit_logs (action)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_actor      ON auth_audit_logs (actor_user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_service    ON auth_audit_logs (service)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_target_id  ON auth_audit_logs (target_id)`,
	}
	for _, q := range stmts {
		if _, err := s.pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("audit schema: %q: %w", q, err)
		}
	}
	return nil
}

// Write inserts a Record and returns the assigned id.
func (s *PostgresStore) Write(ctx context.Context, rec Record) (int64, error) {
	if rec.Service == "" {
		rec.Service = s.defaultService
	}
	if rec.Cluster == "" {
		rec.Cluster = s.defaultCluster
	}
	if rec.Result == "" {
		rec.Result = ResultSuccess
	}

	const q = `
        INSERT INTO auth_audit_logs
          (service, action,
           actor_user_id, actor_email,
           target_user_id, target_email, target_type, target_id,
           before, after,
           request_ip, user_agent, request_id, path,
           cluster, namespace,
           result, error)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        RETURNING id`

	// Column mapping:
	//   target_type == "user" → target_user_id = TargetID, target_email = TargetEmail
	//   other (pod/deployment/release/...) → target_id = TargetID
	// target_id is a generic VARCHAR added in v1.1 so non-user rows also
	// have a queryable/indexable identifier.
	var targetUserID, targetEmail any
	if rec.TargetType == "user" {
		targetUserID = nullIfEmpty(rec.TargetID)
		targetEmail = nullIfEmpty(rec.TargetEmail)
	}

	var id int64
	err := s.pool.QueryRow(ctx, q,
		rec.Service,
		rec.Action,
		nullIfEmpty(rec.ActorUserID),
		nullIfEmpty(rec.ActorEmail),
		targetUserID,
		targetEmail,
		nullIfEmpty(rec.TargetType),
		nullIfEmpty(rec.TargetID),
		jsonOrEmpty(rec.Before),
		jsonOrEmpty(rec.After),
		nullIfEmpty(rec.RequestIP),
		nullIfEmpty(rec.UserAgent),
		nullIfEmpty(rec.RequestID),
		nullIfEmpty(rec.Path),
		nullIfEmpty(rec.Cluster),
		nullIfEmpty(rec.Namespace),
		rec.Result,
		nullIfEmpty(rec.Error),
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("audit insert: %w", err)
	}
	return id, nil
}

// Get returns the entry with the given id, or (nil, nil) if absent.
func (s *PostgresStore) Get(ctx context.Context, id int64) (*Entry, error) {
	rows, err := s.pool.Query(ctx, selectSQL+` WHERE id = $1`, id)
	if err != nil {
		return nil, fmt.Errorf("audit get: %w", err)
	}
	defer rows.Close()
	entries, err := scanEntries(rows)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, nil
	}
	return &entries[0], nil
}

// List returns entries matching the filter plus the total count.
func (s *PostgresStore) List(ctx context.Context, f Filter) ([]Entry, int, error) {
	where, args := buildWhere(f)

	// Total count (without LIMIT/OFFSET)
	countSQL := `SELECT COUNT(*) FROM auth_audit_logs` + where
	var total int
	if err := s.pool.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("audit count: %w", err)
	}

	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}

	pageSQL := selectSQL + where +
		fmt.Sprintf(` ORDER BY created_at DESC LIMIT $%d OFFSET $%d`, len(args)+1, len(args)+2)
	args = append(args, limit, f.Offset)

	rows, err := s.pool.Query(ctx, pageSQL, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("audit list: %w", err)
	}
	defer rows.Close()
	entries, err := scanEntries(rows)
	if err != nil {
		return nil, 0, err
	}
	return entries, total, nil
}

// --- internal helpers ---

const selectSQL = `
    SELECT id, created_at,
           COALESCE(service, ''),
           action,
           COALESCE(actor_user_id, ''), COALESCE(actor_email, ''),
           COALESCE(target_user_id, ''), COALESCE(target_email, ''),
           COALESCE(target_type, ''),  COALESCE(target_id, ''),
           before, after,
           COALESCE(request_ip, ''),  COALESCE(user_agent, ''),
           COALESCE(request_id, ''),  COALESCE(path, ''),
           COALESCE(cluster, ''),     COALESCE(namespace, ''),
           COALESCE(result, 'success'), COALESCE(error, '')
    FROM auth_audit_logs`

func scanEntries(rows pgx.Rows) ([]Entry, error) {
	var out []Entry
	for rows.Next() {
		var e Entry
		var createdAt time.Time
		var before, after []byte
		var targetUserID, targetEmail, targetID string
		if err := rows.Scan(
			&e.ID, &createdAt,
			&e.Service,
			&e.Action,
			&e.ActorUserID, &e.ActorEmail,
			&targetUserID, &targetEmail,
			&e.TargetType, &targetID,
			&before, &after,
			&e.RequestIP, &e.UserAgent,
			&e.RequestID, &e.Path,
			&e.Cluster, &e.Namespace,
			&e.Result, &e.Error,
		); err != nil {
			return nil, fmt.Errorf("audit scan: %w", err)
		}
		e.CreatedAt = createdAt
		if e.TargetType == "user" {
			// Auth-domain rows: identifier lives in target_user_id.
			e.TargetID = targetUserID
			e.TargetEmail = targetEmail
		} else {
			// Generic rows (k8s / helm / ...): identifier lives in target_id.
			e.TargetID = targetID
		}
		if len(before) > 0 && string(before) != "{}" {
			e.Before = json.RawMessage(before)
		}
		if len(after) > 0 && string(after) != "{}" {
			e.After = json.RawMessage(after)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// buildWhere returns the WHERE clause (including the leading " WHERE ")
// plus the corresponding arg slice. Returns an empty clause when no filter
// is set.
func buildWhere(f Filter) (string, []any) {
	var clauses []string
	var args []any
	add := func(expr string, v any) {
		args = append(args, v)
		clauses = append(clauses, fmt.Sprintf(expr, len(args)))
	}
	if f.Service != "" {
		add(`service = $%d`, f.Service)
	}
	if f.Action != "" {
		add(`action = $%d`, f.Action)
	}
	if f.ActorEmail != "" {
		add(`actor_email = $%d`, f.ActorEmail)
	}
	if f.TargetID != "" {
		// Match either the generic target_id column or the legacy
		// target_user_id column (populated only for target_type='user').
		args = append(args, f.TargetID, f.TargetID)
		clauses = append(clauses, fmt.Sprintf(
			`(target_id = $%d OR target_user_id = $%d)`,
			len(args)-1, len(args)))
	}
	if f.Cluster != "" {
		add(`cluster = $%d`, f.Cluster)
	}
	if f.Namespace != "" {
		add(`namespace = $%d`, f.Namespace)
	}
	if f.Result != "" {
		add(`result = $%d`, f.Result)
	}
	if !f.Since.IsZero() {
		add(`created_at >= $%d`, f.Since)
	}
	if !f.Until.IsZero() {
		add(`created_at <= $%d`, f.Until)
	}
	if len(clauses) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func jsonOrEmpty(raw json.RawMessage) []byte {
	if len(raw) == 0 {
		return []byte("{}")
	}
	return raw
}
