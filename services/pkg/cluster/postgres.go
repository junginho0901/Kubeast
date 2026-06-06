package cluster

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"k8s.io/client-go/rest"
)

// PostgresRegistry is a Registry backed by the `clusters` table (owned by
// auth-service) plus a SecretReader for external clusters' kubeconfigs.
//
// When no clusters are registered yet (fresh install, before Setup) List
// returns empty and Default returns ErrNotFound; callers start unconfigured
// and connect lazily once the first cluster is registered (no env fallback,
// no rollout).
type PostgresRegistry struct {
	pool    *pgxpool.Pool
	secrets SecretReader
}

// NewPostgresRegistry builds a registry over pool, loading external kubeconfigs
// through secrets.
func NewPostgresRegistry(pool *pgxpool.Pool, secrets SecretReader) *PostgresRegistry {
	return &PostgresRegistry{pool: pool, secrets: secrets}
}

// VerifySchema reports whether the clusters table is queryable yet (auth
// service may still be creating it). Callers can back off and retry.
func (r *PostgresRegistry) VerifySchema(ctx context.Context) error {
	if _, err := r.pool.Exec(ctx, `SELECT 1 FROM clusters LIMIT 1`); err != nil {
		return fmt.Errorf("clusters schema not ready: %w", err)
	}
	return nil
}

// List returns all registered clusters (metadata only — kubeconfig blobs are
// loaded lazily by Get). Empty when nothing is registered.
func (r *PostgresRegistry) List(ctx context.Context) ([]Info, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, display_name, mode, is_self_cluster
		FROM clusters
		ORDER BY is_self_cluster DESC, display_name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Info
	for rows.Next() {
		var (
			info Info
			mode string
		)
		if err := rows.Scan(&info.ID, &info.DisplayName, &mode, &info.IsSelfCluster); err != nil {
			return nil, err
		}
		info.Mode = Mode(mode)
		if info.IsSelfCluster {
			info.InCluster = true
		}
		out = append(out, info)
	}
	return out, rows.Err()
}

// Get returns a cluster with its connection details resolved: self clusters use
// the in-cluster ServiceAccount; external clusters have their kubeconfig blob
// loaded from the secret store.
func (r *PostgresRegistry) Get(ctx context.Context, id ID) (*Info, error) {
	var (
		info       Info
		mode       string
		secretName *string
		apiURL     *string
	)
	err := r.pool.QueryRow(ctx, `
		SELECT id, display_name, mode, kubeconfig_secret_name, api_server_url, is_self_cluster
		FROM clusters WHERE id = $1`, id,
	).Scan(&info.ID, &info.DisplayName, &mode, &secretName, &apiURL, &info.IsSelfCluster)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	info.Mode = Mode(mode)

	if info.IsSelfCluster {
		info.InCluster = true
		return &info, nil
	}
	if secretName != nil && *secretName != "" && r.secrets != nil {
		blob, err := r.secrets.ReadKubeconfig(ctx, *secretName)
		if err != nil {
			return nil, fmt.Errorf("load kubeconfig for cluster %s: %w", id, err)
		}
		info.KubeconfigBlob = blob
	}
	return &info, nil
}

// Default returns the self cluster if any, else the oldest registered cluster.
// Returns ErrNotFound when nothing is registered (pre-Setup).
func (r *PostgresRegistry) Default(ctx context.Context) (ID, error) {
	var id ID
	err := r.pool.QueryRow(ctx, `
		SELECT id FROM clusters
		ORDER BY is_self_cluster DESC, created_at ASC
		LIMIT 1`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

// --- Admin metadata view (no kubeconfig blob) ---

// Meta is the full metadata of a registered cluster, used by the admin CRUD
// API. Unlike Info (which carries connection details for runtime access), Meta
// never includes the kubeconfig blob.
type Meta struct {
	ID                ID         `json:"id"`
	DisplayName       string     `json:"display_name"`
	Mode              Mode       `json:"mode"`
	APIServerURL      string     `json:"api_server_url,omitempty"`
	IsSelfCluster     bool       `json:"is_self_cluster"`
	HealthStatus      string     `json:"health_status"`
	LastHealthcheckAt *time.Time `json:"last_healthcheck_at,omitempty"`
	CreatedBy         string     `json:"created_by"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

func scanMeta(row pgx.Row) (Meta, error) {
	var (
		m         Meta
		mode      string
		apiURL    *string
		lastCheck *time.Time
		health    *string
	)
	if err := row.Scan(&m.ID, &m.DisplayName, &mode, &apiURL, &m.IsSelfCluster,
		&health, &lastCheck, &m.CreatedBy, &m.CreatedAt, &m.UpdatedAt); err != nil {
		return Meta{}, err
	}
	m.Mode = Mode(mode)
	if apiURL != nil {
		m.APIServerURL = *apiURL
	}
	if health != nil {
		m.HealthStatus = *health
	}
	m.LastHealthcheckAt = lastCheck
	return m, nil
}

const metaColumns = `id, display_name, mode, api_server_url, is_self_cluster,
	health_status, last_healthcheck_at, created_by, created_at, updated_at`

// ListMeta returns metadata for every registered cluster (admin CRUD list).
func (r *PostgresRegistry) ListMeta(ctx context.Context) ([]Meta, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+metaColumns+`
		FROM clusters ORDER BY is_self_cluster DESC, display_name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Meta, 0)
	for rows.Next() {
		m, err := scanMeta(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetMeta returns one cluster's metadata, or ErrNotFound.
func (r *PostgresRegistry) GetMeta(ctx context.Context, id ID) (*Meta, error) {
	m, err := scanMeta(r.pool.QueryRow(ctx, `SELECT `+metaColumns+`
		FROM clusters WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// --- Write methods ---

// AddExternal registers an external cluster: it stores the kubeconfig through
// writer (a Secret in helm mode, a file in docker mode) and inserts the
// clusters row. The ID is slugify(displayName) and is immutable. On INSERT
// failure the just-written secret is rolled back so a failed registration
// leaves no orphan. No rollout is triggered — k8s-service reads the secret
// lazily on the first ?cluster={id} request (00-COMMON §2-4).
func (r *PostgresRegistry) AddExternal(ctx context.Context, displayName, kubeconfig, apiServerURL, createdBy string, writer SecretWriter) (*Meta, error) {
	id := ID(Slugify(displayName))
	if id == "" {
		return nil, fmt.Errorf("cluster: display name produces empty id: %q", displayName)
	}
	if writer == nil {
		return nil, fmt.Errorf("cluster: no secret store configured (cannot store kubeconfig)")
	}
	exists, err := r.exists(ctx, id)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, ErrAlreadyExists
	}

	secretName, err := writer.WriteKubeconfig(ctx, id, kubeconfig)
	if err != nil {
		return nil, fmt.Errorf("store kubeconfig: %w", err)
	}
	_, err = r.pool.Exec(ctx, `
		INSERT INTO clusters (id, display_name, mode, kubeconfig_secret_name, api_server_url, is_self_cluster, created_by)
		VALUES ($1, $2, $3, $4, $5, false, $6)`,
		id, displayName, string(ModeExternal), secretName, nullIfEmpty(apiServerURL), createdBy)
	if err != nil {
		// Roll back the secret so a failed registration leaves nothing behind.
		if delErr := writer.DeleteKubeconfig(ctx, secretName); delErr != nil {
			slog.Warn("cluster: kubeconfig rollback after failed insert failed", "id", id, "err", delErr)
		}
		return nil, fmt.Errorf("insert cluster: %w", err)
	}
	return r.GetMeta(ctx, id)
}

// AddSelf registers the cluster kubeast itself runs in, using the in-cluster
// ServiceAccount (no kubeconfig secret). Fails if not running in-cluster.
func (r *PostgresRegistry) AddSelf(ctx context.Context, displayName, createdBy string) (*Meta, error) {
	if _, err := rest.InClusterConfig(); err != nil {
		return nil, fmt.Errorf("cluster: not running in-cluster, cannot register self: %w", err)
	}
	id := ID(Slugify(displayName))
	if id == "" {
		return nil, fmt.Errorf("cluster: display name produces empty id: %q", displayName)
	}
	exists, err := r.exists(ctx, id)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, ErrAlreadyExists
	}
	_, err = r.pool.Exec(ctx, `
		INSERT INTO clusters (id, display_name, mode, kubeconfig_secret_name, is_self_cluster, created_by)
		VALUES ($1, $2, $3, NULL, true, $4)`,
		id, displayName, string(ModeInCluster), createdBy)
	if err != nil {
		return nil, fmt.Errorf("insert self cluster: %w", err)
	}
	return r.GetMeta(ctx, id)
}

// Remove deletes a cluster row (CASCADE clears its user_cluster_roles) and
// best-effort removes its kubeconfig secret. A secret-delete failure does not
// fail the call — the row is already gone.
func (r *PostgresRegistry) Remove(ctx context.Context, id ID, writer SecretWriter) error {
	var secretName *string
	err := r.pool.QueryRow(ctx, `SELECT kubeconfig_secret_name FROM clusters WHERE id = $1`, id).Scan(&secretName)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if _, err := r.pool.Exec(ctx, `DELETE FROM clusters WHERE id = $1`, id); err != nil {
		return fmt.Errorf("delete cluster: %w", err)
	}
	if secretName != nil && *secretName != "" && writer != nil {
		if err := writer.DeleteKubeconfig(ctx, *secretName); err != nil {
			slog.Warn("cluster: best-effort kubeconfig secret delete failed", "id", id, "secret", *secretName, "err", err)
		}
	}
	return nil
}

// UpdateMeta updates the mutable metadata of a cluster (display name and the
// display-only API server URL). The ID is immutable. nil fields are left
// unchanged.
func (r *PostgresRegistry) UpdateMeta(ctx context.Context, id ID, displayName, apiServerURL *string) (*Meta, error) {
	tag, err := r.pool.Exec(ctx, `
		UPDATE clusters
		SET display_name   = COALESCE($2, display_name),
		    api_server_url = COALESCE($3, api_server_url),
		    updated_at     = NOW()
		WHERE id = $1`, id, displayName, apiServerURL)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	return r.GetMeta(ctx, id)
}

// UpdateHealth records the outcome of a connectivity check.
func (r *PostgresRegistry) UpdateHealth(ctx context.Context, id ID, status string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE clusters
		SET health_status = $2, last_healthcheck_at = NOW(), updated_at = NOW()
		WHERE id = $1`, id, status)
	return err
}

func (r *PostgresRegistry) exists(ctx context.Context, id ID) (bool, error) {
	var one int
	err := r.pool.QueryRow(ctx, `SELECT 1 FROM clusters WHERE id = $1`, id).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func nullIfEmpty(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

// Slugify converts a display name to a URL-safe cluster ID: lowercase, with
// runs of non-alphanumeric characters collapsed to single hyphens and leading/
// trailing hyphens trimmed. e.g. "Prod East 1" -> "prod-east-1".
func Slugify(s string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.TrimRight(b.String(), "-")
}
