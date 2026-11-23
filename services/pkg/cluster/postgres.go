package cluster

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
	// storeLimit is storeTimeout unless a test sets it.
	storeLimit time.Duration
}

// storeTimeout bounds the store of one clusters row change (changeRow): it runs while the transaction holds the row's
// lock and a pool connection, and the Kubernetes client of the Secret store sets no timeout on a write.
const storeTimeout = 10 * time.Second

// putBackTimeout bounds putting back the Secrets of a change that did not commit, which goes on after its request.
const putBackTimeout = 10 * time.Second

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

// listColumns are the columns Get reads into an Info, but those naming Secrets
// (TestListReadsTheColumnsGetReads).
const listColumns = `id, display_name, mode, is_self_cluster,
	COALESCE(prometheus_url, ''), COALESCE(prometheus_cluster_label, ''), COALESCE(prometheus_service, ''),
	COALESCE(log_search_url, ''), COALESCE(log_search_tenant, ''), COALESCE(log_search_cluster_label, ''), config_version`

// getColumns are the columns Get reads.
const getColumns = `id, display_name, mode, kubeconfig_secret_name, api_server_url, is_self_cluster,
	prometheus_url, prometheus_auth_secret_name, prometheus_cluster_label, prometheus_service,
	log_search_url, log_search_auth_secret_name, log_search_tenant, log_search_cluster_label, config_version`

// List returns all registered clusters with what their rows hold, as Get
// reads it; what Secrets hold (kubeconfig blobs, auth headers) only Get
// loads. Empty when nothing is registered.
func (r *PostgresRegistry) List(ctx context.Context) ([]Info, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+listColumns+`
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
		if err := rows.Scan(&info.ID, &info.DisplayName, &mode, &info.IsSelfCluster,
			&info.PrometheusURL, &info.PrometheusClusterLabel, &info.PrometheusService,
			&info.LogSearchURL, &info.LogSearchTenant, &info.LogSearchClusterLabel, &info.ConfigVersion); err != nil {
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
		promURL    *string
		promSecret *string
		promLabel  *string
		promSvc    *string
		lsURL      *string
		lsSecret   *string
		lsTenant   *string
		lsLabel    *string
	)
	err := r.pool.QueryRow(ctx, `
		SELECT `+getColumns+`
		FROM clusters WHERE id = $1`, id,
	).Scan(&info.ID, &info.DisplayName, &mode, &secretName, &apiURL, &info.IsSelfCluster, &promURL, &promSecret, &promLabel, &promSvc,
		&lsURL, &lsSecret, &lsTenant, &lsLabel, &info.ConfigVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	info.Mode = Mode(mode)
	if promURL != nil {
		info.PrometheusURL = *promURL
	}
	if promLabel != nil {
		info.PrometheusClusterLabel = *promLabel
	}
	if promSvc != nil {
		info.PrometheusService = *promSvc
	}
	// The Authorization header is optional for metrics: a missing Secret is
	// logged and the cluster stays usable (its Prometheus status says 401).
	if promSecret != nil && *promSecret != "" && r.secrets != nil {
		if h, err := r.secrets.ReadValue(ctx, *promSecret, PrometheusAuthKey); err != nil {
			slog.Warn("cluster: prometheus auth secret unreadable", "id", id, "secret", *promSecret, "err", err)
		} else {
			info.PrometheusAuthHeader = h
		}
	}
	if lsURL != nil {
		info.LogSearchURL = *lsURL
	}
	if lsTenant != nil {
		info.LogSearchTenant = *lsTenant
	}
	if lsLabel != nil {
		info.LogSearchClusterLabel = *lsLabel
	}
	// Same for the log store: without the header the store answers 401 and the
	// log search status says so.
	if lsSecret != nil && *lsSecret != "" && r.secrets != nil {
		if h, err := r.secrets.ReadValue(ctx, *lsSecret, LogSearchAuthKey); err != nil {
			slog.Warn("cluster: log search auth secret unreadable", "id", id, "secret", *lsSecret, "err", err)
		} else {
			info.LogSearchAuthHeader = h
		}
	}

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

// Versions returns every registered cluster's config_version, by id: one read
// of the clusters table, a row per cluster. A cluster with no entry is gone.
// The row is read in Get before the Secrets, and auth-service writes a Secret
// before the row change that sets the new version commits (changeRow), so an
// Info whose ConfigVersion equals the one here holds what that version names.
// A change that does not commit puts its Secrets back and then sets one more
// new version, so an Info built meanwhile from what it wrote is dropped too.
func (r *PostgresRegistry) Versions(ctx context.Context) (map[ID]int64, error) {
	rows, err := r.pool.Query(ctx, `SELECT id, config_version FROM clusters`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[ID]int64{}
	for rows.Next() {
		var (
			id ID
			v  int64
		)
		if err := rows.Scan(&id, &v); err != nil {
			return nil, err
		}
		out[id] = v
	}
	return out, rows.Err()
}

// --- Admin metadata view (no kubeconfig blob) ---

// Meta is the full metadata of a registered cluster, used by the admin CRUD
// API. Unlike Info (which carries connection details for runtime access), Meta
// never includes the kubeconfig blob.
type Meta struct {
	ID            ID     `json:"id"`
	DisplayName   string `json:"display_name"`
	Mode          Mode   `json:"mode"`
	APIServerURL  string `json:"api_server_url,omitempty"`
	IsSelfCluster bool   `json:"is_self_cluster"`
	// External Prometheus source (empty = found inside the cluster); the auth
	// header itself never leaves the Secret, only whether one is set.
	PrometheusURL          string `json:"prometheus_url,omitempty"`
	PrometheusClusterLabel string `json:"prometheus_cluster_label,omitempty"`
	PrometheusAuth         bool   `json:"prometheus_auth"`
	// Prometheus Service in the cluster ("namespace/service:port"; empty = discover).
	PrometheusService string `json:"prometheus_service,omitempty"`
	// This cluster's own log store (empty = the deployment-wide one); the auth
	// header never leaves the Secret, only whether one is set.
	LogSearchURL          string     `json:"log_search_url,omitempty"`
	LogSearchTenant       string     `json:"log_search_tenant,omitempty"`
	LogSearchClusterLabel string     `json:"log_search_cluster_label,omitempty"`
	LogSearchAuth         bool       `json:"log_search_auth"`
	HealthStatus          string     `json:"health_status"`
	LastHealthcheckAt     *time.Time `json:"last_healthcheck_at,omitempty"`
	CreatedBy             string     `json:"created_by"`
	CreatedAt             time.Time  `json:"created_at"`
	UpdatedAt             time.Time  `json:"updated_at"`
}

// WithoutURLUser is a server address without the user and password written into it. api_server_url is what the screens
// and the audit rows show; connecting goes by the kubeconfig. An address with no scheme or that url.Parse cannot read
// (a password with a space or a slash) counts too.
func WithoutURLUser(raw string) string {
	start := 0
	if i := strings.Index(raw, "://"); i >= 0 {
		start = i + 3
	} else if strings.HasPrefix(raw, "//") {
		start = 2
	}
	end, queryAt := len(raw), len(raw)
	if i := strings.IndexAny(raw[start:], "/?#"); i >= 0 {
		end = start + i
	}
	if i := strings.IndexAny(raw[start:], "?#"); i >= 0 {
		queryAt = start + i
	}
	at := strings.LastIndex(raw[start:end], "@")
	if at < 0 {
		if _, err := url.Parse(raw); err == nil {
			return raw
		}
		if at = strings.LastIndex(raw[start:queryAt], "@"); at < 0 {
			return raw
		}
	}
	return raw[:start] + raw[start+at+1:]
}

func scanMeta(row pgx.Row) (Meta, error) {
	var (
		m          Meta
		mode       string
		apiURL     *string
		lastCheck  *time.Time
		health     *string
		promURL    *string
		promSecret *string
		promLabel  *string
		promSvc    *string
		lsURL      *string
		lsSecret   *string
		lsTenant   *string
		lsLabel    *string
	)
	if err := row.Scan(&m.ID, &m.DisplayName, &mode, &apiURL, &m.IsSelfCluster,
		&health, &lastCheck, &m.CreatedBy, &m.CreatedAt, &m.UpdatedAt, &promURL, &promSecret, &promLabel, &promSvc,
		&lsURL, &lsSecret, &lsTenant, &lsLabel); err != nil {
		return Meta{}, err
	}
	if lsURL != nil {
		m.LogSearchURL = *lsURL
	}
	if lsTenant != nil {
		m.LogSearchTenant = *lsTenant
	}
	if lsLabel != nil {
		m.LogSearchClusterLabel = *lsLabel
	}
	m.LogSearchAuth = lsSecret != nil && *lsSecret != ""
	m.Mode = Mode(mode)
	if apiURL != nil {
		m.APIServerURL = WithoutURLUser(*apiURL)
	}
	if promURL != nil {
		m.PrometheusURL = *promURL
	}
	if promLabel != nil {
		m.PrometheusClusterLabel = *promLabel
	}
	if promSvc != nil {
		m.PrometheusService = *promSvc
	}
	m.PrometheusAuth = promSecret != nil && *promSecret != ""
	if health != nil {
		m.HealthStatus = *health
	}
	m.LastHealthcheckAt = lastCheck
	return m, nil
}

const metaColumns = `id, display_name, mode, api_server_url, is_self_cluster,
	health_status, last_healthcheck_at, created_by, created_at, updated_at,
	prometheus_url, prometheus_auth_secret_name, prometheus_cluster_label, prometheus_service,
	log_search_url, log_search_auth_secret_name, log_search_tenant, log_search_cluster_label`

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
func (r *PostgresRegistry) AddExternal(ctx context.Context, displayName, kubeconfig, apiServerURL, clusterUID, createdBy string, writer SecretWriter) (*Meta, error) {
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
		INSERT INTO clusters (id, display_name, mode, kubeconfig_secret_name, api_server_url, cluster_uid, is_self_cluster, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
		id, displayName, string(ModeExternal), secretName, nullIfEmpty(apiServerURL), nullIfEmpty(clusterUID), createdBy)
	if err != nil {
		// Roll back the secret so a failed registration leaves nothing behind.
		if delErr := writer.DeleteKubeconfig(ctx, secretName); delErr != nil {
			slog.Warn("cluster: kubeconfig rollback after failed insert failed", "id", id, "err", delErr)
		}
		return nil, fmt.Errorf("insert cluster: %w", err)
	}
	return r.GetMeta(ctx, id)
}

// ClusterIDByUID returns the id of a registered cluster whose stored fingerprint
// (kube-system namespace UID) matches uid, or ErrNotFound. Used to reject a
// kubeconfig that points at an already-registered physical cluster.
func (r *PostgresRegistry) ClusterIDByUID(ctx context.Context, uid string) (ID, error) {
	if uid == "" {
		return "", ErrNotFound
	}
	var id string
	err := r.pool.QueryRow(ctx,
		`SELECT id FROM clusters WHERE cluster_uid = $1 LIMIT 1`, uid).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return ID(id), nil
}

// AddSelf registers the cluster kubeast itself runs in, using the in-cluster
// ServiceAccount (no kubeconfig secret). Fails if not running in-cluster, and with
// a *SameClusterError when this cluster is registered already, in-cluster or by a kubeconfig.
// The row keeps the cluster's kube-system UID, as an external one does; one that
// cannot be read leaves it empty for FillSelfUID.
func (r *PostgresRegistry) AddSelf(ctx context.Context, displayName, createdBy string) (*Meta, error) {
	if _, err := inClusterConfig(); err != nil {
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
	// Every in-cluster row is the cluster Kubeast runs in, so a second one is the same cluster under another name.
	var self string
	switch err := r.pool.QueryRow(ctx, `SELECT id FROM clusters WHERE is_self_cluster LIMIT 1`).Scan(&self); {
	case err == nil:
		return nil, &SameClusterError{ID: ID(self)}
	case !errors.Is(err, pgx.ErrNoRows):
		return nil, err
	}
	uid, uerr := SelfUID(ctx)
	if uerr != nil {
		slog.Warn("cluster: kube-system UID of this cluster not read, registered without it", "id", id, "err", uerr)
		uid = ""
	}
	if uid != "" {
		if existing, ferr := r.ClusterIDByUID(ctx, uid); ferr == nil {
			return nil, &SameClusterError{ID: existing}
		}
	}
	_, err = r.pool.Exec(ctx, `
		INSERT INTO clusters (id, display_name, mode, kubeconfig_secret_name, cluster_uid, is_self_cluster, created_by)
		VALUES ($1, $2, $3, NULL, $4, true, $5)`,
		id, displayName, string(ModeInCluster), nullIfEmpty(uid), createdBy)
	if err != nil {
		return nil, fmt.Errorf("insert self cluster: %w", err)
	}
	return r.GetMeta(ctx, id)
}

// Remove deletes a cluster row (CASCADE clears its user_cluster_roles, and the
// holders of those grants get a new token_version) and best-effort removes its kubeconfig secret. A secret-delete failure does not
// fail the call — the row is already gone.
func (r *PostgresRegistry) Remove(ctx context.Context, id ID, writer SecretWriter) error {
	var secretName, promSecret, lsSecret *string
	err := r.pool.QueryRow(ctx, `SELECT kubeconfig_secret_name, prometheus_auth_secret_name, log_search_auth_secret_name FROM clusters WHERE id = $1`, id).Scan(&secretName, &promSecret, &lsSecret)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	// The cascade takes the grants, so the tokens carrying them end in the same statement, as any other grant change does.
	if _, err := r.pool.Exec(ctx, `
		WITH ended AS (
			UPDATE auth_users SET token_version = token_version + 1, updated_at = NOW()
			WHERE id IN (SELECT user_id FROM user_cluster_roles WHERE cluster_id = $1)
		)
		DELETE FROM clusters WHERE id = $1`, id); err != nil {
		return fmt.Errorf("delete cluster: %w", err)
	}
	if secretName != nil && *secretName != "" && writer != nil {
		if err := writer.DeleteKubeconfig(ctx, *secretName); err != nil {
			slog.Warn("cluster: best-effort kubeconfig secret delete failed", "id", id, "secret", *secretName, "err", err)
		}
	}
	if promSecret != nil && *promSecret != "" && writer != nil {
		if err := writer.DeleteSecret(ctx, *promSecret); err != nil {
			slog.Warn("cluster: best-effort prometheus secret delete failed", "id", id, "secret", *promSecret, "err", err)
		}
	}
	if lsSecret != nil && *lsSecret != "" && writer != nil {
		if err := writer.DeleteSecret(ctx, *lsSecret); err != nil {
			slog.Warn("cluster: best-effort log search secret delete failed", "id", id, "secret", *lsSecret, "err", err)
		}
	}
	return nil
}

// MetaPatch is what UpdateMeta changes: nil leaves a field as it is; for the
// Prometheus fields an empty string clears it (NULL).
type MetaPatch struct {
	DisplayName              *string
	APIServerURL             *string
	PrometheusURL            *string
	PrometheusAuthSecretName *string
	PrometheusClusterLabel   *string
	PrometheusService        *string
	LogSearchURL             *string
	LogSearchAuthSecretName  *string
	LogSearchTenant          *string
	LogSearchClusterLabel    *string
}

// LogSearchAuthSecretName returns the name of the Secret holding cluster id's
// log store Authorization header, or "" when none is set.
func (r *PostgresRegistry) LogSearchAuthSecretName(ctx context.Context, id ID) (string, error) {
	var name *string
	err := r.pool.QueryRow(ctx, `SELECT log_search_auth_secret_name FROM clusters WHERE id = $1`, id).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil || name == nil {
		return "", err
	}
	return *name, nil
}

// PrometheusAuthSecretName returns the name of the Secret holding cluster id's
// Prometheus Authorization header, or "" when none is set.
func (r *PostgresRegistry) PrometheusAuthSecretName(ctx context.Context, id ID) (string, error) {
	var name *string
	err := r.pool.QueryRow(ctx, `SELECT prometheus_auth_secret_name FROM clusters WHERE id = $1`, id).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil || name == nil {
		return "", err
	}
	return *name, nil
}

// changesConnection is whether the patch changes what k8s-service builds a
// cluster's connection from: the Prometheus source and the log store, kept on
// its per-cluster bundle. The display name and the API server URL, which is
// shown only, do not.
func (p MetaPatch) changesConnection() bool {
	return p.PrometheusURL != nil || p.PrometheusAuthSecretName != nil || p.PrometheusClusterLabel != nil || p.PrometheusService != nil ||
		p.LogSearchURL != nil || p.LogSearchAuthSecretName != nil || p.LogSearchTenant != nil || p.LogSearchClusterLabel != nil
}

// UpdateMeta updates the mutable metadata of a cluster (display name, the
// display-only API server URL and the Prometheus source). The ID is immutable.
// A patch that changes the connection (changesConnection) sets a new
// config_version in the same statement.
func (r *PostgresRegistry) UpdateMeta(ctx context.Context, id ID, patch MetaPatch) (*Meta, error) {
	return r.UpdateMetaStoring(ctx, id, patch, SecretWrites{})
}

// UpdateMetaStoring is UpdateMeta writing w (the Prometheus and log store
// header Secrets) before the row change commits (changeRow). A patch with
// Secret writes changes the connection, so it sets a new config_version.
func (r *PostgresRegistry) UpdateMetaStoring(ctx context.Context, id ID, patch MetaPatch, w SecretWrites) (*Meta, error) {
	err := r.changeRow(ctx, id, `
		UPDATE clusters
		SET display_name                = COALESCE($2, display_name),
		    api_server_url              = COALESCE($3, api_server_url),
		    prometheus_url              = CASE WHEN $4::varchar IS NULL THEN prometheus_url ELSE NULLIF($4, '') END,
		    prometheus_auth_secret_name = CASE WHEN $5::varchar IS NULL THEN prometheus_auth_secret_name ELSE NULLIF($5, '') END,
		    prometheus_cluster_label    = CASE WHEN $6::varchar IS NULL THEN prometheus_cluster_label ELSE NULLIF($6, '') END,
		    prometheus_service          = CASE WHEN $7::varchar IS NULL THEN prometheus_service ELSE NULLIF($7, '') END,
		    log_search_url              = CASE WHEN $8::varchar IS NULL THEN log_search_url ELSE NULLIF($8, '') END,
		    log_search_auth_secret_name = CASE WHEN $9::varchar IS NULL THEN log_search_auth_secret_name ELSE NULLIF($9, '') END,
		    log_search_tenant           = CASE WHEN $10::varchar IS NULL THEN log_search_tenant ELSE NULLIF($10, '') END,
		    log_search_cluster_label    = CASE WHEN $11::varchar IS NULL THEN log_search_cluster_label ELSE NULLIF($11, '') END,
		    config_version              = CASE WHEN $12 THEN nextval('cluster_config_version_seq') ELSE config_version END,
		    updated_at                  = NOW()
		WHERE id = $1`, []any{id, patch.DisplayName, patch.APIServerURL, patch.PrometheusURL, patch.PrometheusAuthSecretName, patch.PrometheusClusterLabel, patch.PrometheusService,
		patch.LogSearchURL, patch.LogSearchAuthSecretName, patch.LogSearchTenant, patch.LogSearchClusterLabel, patch.changesConnection()}, w)
	if err != nil {
		return nil, err
	}
	return r.GetMeta(ctx, id)
}

// SecretWrites is what one clusters row change writes to the Secret store
// (ReplaceKubeconfig, UpdateMetaStoring). The zero value writes nothing.
type SecretWrites struct {
	// Store writes them before the change commits; an error rolls it back.
	Store func(ctx context.Context) error
	// PutBack writes back what Store replaced, when the change does not
	// commit after Store ran. changed is whether Store had changed a Secret
	// (one it wrote, or whose write ran out of time); left names what stays as
	// written ("" when nothing does).
	PutBack func(ctx context.Context) (changed bool, left string)
}

func (w SecretWrites) putBack(ctx context.Context) (bool, string) {
	if w.PutBack == nil {
		return false, ""
	}
	return w.PutBack(ctx)
}

// PutBackError is a clusters row change that did not commit (Err) after its
// Secret writes began, when what they did could not all be undone: Left says
// what stays as written or which connections were not dropped.
type PutBackError struct {
	Err  error
	Left string
}

func (e *PutBackError) Error() string { return e.Err.Error() + "; " + e.Left }
func (e *PutBackError) Unwrap() error { return e.Err }

func withLeft(err error, left []string) error {
	if len(left) == 0 {
		return err
	}
	return &PutBackError{Err: err, Left: strings.Join(left, "; ")}
}

const (
	lockRowSQL    = `SELECT config_version FROM clusters WHERE id = $1 FOR NO KEY UPDATE`
	newVersionSQL = `UPDATE clusters SET config_version = nextval('cluster_config_version_seq') WHERE id = $1`
	// notDropped is what stays when a change that wrote a Secret and did not
	// commit could not set a new config_version after putting it back.
	notDropped = "connections made meanwhile from the Secrets written are kept (a new config_version could not be set)"
)

// changeRow locks a clusters row, runs one UPDATE of it, then w.Store, in a
// transaction that commits only when both succeed, so config_version moves
// only when the Secrets store writes are in place. Until the commit, readers
// see the row as it was; a k8s-service process that reads a Secret store wrote
// meanwhile has built from the old version and drops that connection at its
// next read of Versions. When the change does not commit after Store ran, what
// Store wrote is put back (undoStore, undoCommit) and the cluster gets one
// more new config_version, so a connection built from it meanwhile, under the
// version before, is dropped as well; what could not be undone is a
// PutBackError. Store runs with its own deadline (storeTimeout); past it, it
// fails like any other error. ErrNotFound when no row matched (Store is not
// run). Store runs only with an UPDATE that sets a new config_version.
func (r *PostgresRegistry) changeRow(ctx context.Context, id ID, sql string, args []any, w SecretWrites) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }() // after Commit it returns pgx.ErrTxClosed
	var before, after int64
	err = tx.QueryRow(ctx, lockRowSQL, id).Scan(&before)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, sql+" RETURNING config_version", args...).Scan(&after); err != nil {
		return err
	}
	if w.Store == nil {
		return tx.Commit(ctx)
	}
	limit := r.storeLimit
	if limit <= 0 {
		limit = storeTimeout
	}
	storeCtx, cancel := context.WithTimeout(ctx, limit)
	err = w.Store(storeCtx)
	cancel()
	if err != nil {
		return r.undoStore(ctx, tx, id, w, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return r.undoCommit(ctx, id, before, after, w, err)
	}
	return nil
}

// undoStore puts back what a failed Store wrote while tx still holds the row,
// so no other change of the cluster reads or writes its Secrets in between,
// then lets the row go and, when a Secret had changed, sets a new
// config_version.
func (r *PostgresRegistry) undoStore(ctx context.Context, tx pgx.Tx, id ID, w SecretWrites, cause error) error {
	putCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), putBackTimeout)
	changed, putLeft := w.putBack(putCtx)
	cancel()
	var left []string
	if putLeft != "" {
		left = append(left, "left as written: "+putLeft)
	}
	endCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), putBackTimeout)
	defer cancel()
	_ = tx.Rollback(endCtx)
	if changed {
		if _, err := r.pool.Exec(endCtx, newVersionSQL, id); err != nil {
			slog.Error("cluster: no new config_version after putting back the Secrets of a change that did not commit", "id", id, "err", err)
			left = append(left, notDropped)
		}
	}
	return withLeft(cause, left)
}

// undoCommit answers a commit that failed after Store wrote. The row's lock
// went with the transaction, so it locks the row again and reads
// config_version: the change's own value means the commit went through and
// only its answer was lost (nil); the value before means no other change came
// in between, so the Secrets are put back and the cluster gets a new
// config_version in that transaction; another value means a later change of
// the cluster came first, and the Secrets stay as they are.
func (r *PostgresRegistry) undoCommit(ctx context.Context, id ID, before, after int64, w SecretWrites, cause error) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), putBackTimeout)
	defer cancel()
	const notRead = "left as written: the Secrets of this change (the cluster row could not be read again to put them back)"
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		slog.Error("cluster: cannot lock the row again after a failed commit", "id", id, "err", err)
		return withLeft(cause, []string{notRead})
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var now int64
	err = tx.QueryRow(ctx, lockRowSQL, id).Scan(&now)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return cause // removed since, with its Secrets
	case err != nil:
		slog.Error("cluster: cannot lock the row again after a failed commit", "id", id, "err", err)
		return withLeft(cause, []string{notRead})
	case now == after:
		return nil
	case now != before:
		return withLeft(cause, []string{"left as written: the Secrets of this change (the cluster was changed again before they could be put back)"})
	}
	changed, putLeft := w.putBack(ctx)
	var left []string
	if putLeft != "" {
		left = append(left, "left as written: "+putLeft)
	}
	if changed {
		_, err := tx.Exec(ctx, newVersionSQL, id)
		if err == nil {
			err = tx.Commit(ctx)
		}
		if err != nil {
			slog.Error("cluster: no new config_version after putting back the Secrets of a change that did not commit", "id", id, "err", err)
			left = append(left, notDropped)
		}
	}
	return withLeft(cause, left)
}

// ClusterUID returns a cluster's stored fingerprint (kube-system namespace UID),
// or "" if none recorded yet (legacy rows / self clusters).
func (r *PostgresRegistry) ClusterUID(ctx context.Context, id ID) (string, error) {
	var uid *string
	err := r.pool.QueryRow(ctx, `SELECT cluster_uid FROM clusters WHERE id = $1`, id).Scan(&uid)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if uid == nil {
		return "", nil
	}
	return *uid, nil
}

// ReplaceKubeconfig replaces cluster id's kubeconfig: a new config_version
// and, when uid is not empty, the cluster's fingerprint (kube-system namespace
// UID, e.g. backfilling a legacy row on its first rotation), with w, which
// writes the kubeconfig Secret, run before that row change commits
// (changeRow). A failure of either leaves the UID as it was and the Secret as
// it was; config_version is then new only when the Secret had been written.
func (r *PostgresRegistry) ReplaceKubeconfig(ctx context.Context, id ID, uid string, w SecretWrites) error {
	return r.changeRow(ctx, id, `
		UPDATE clusters
		SET cluster_uid = COALESCE($2, cluster_uid), config_version = nextval('cluster_config_version_seq'), updated_at = NOW()
		WHERE id = $1`,
		[]any{id, nullIfEmpty(uid)}, w)
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
