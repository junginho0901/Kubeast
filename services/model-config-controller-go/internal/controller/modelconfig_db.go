package controller

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v4/stdlib"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
)

// requiredSchemaVersion is the goose version (services/pkg/dbmigrate.Required)
// this build needs. The controller module is built on its own, so the check is
// inlined here instead of importing the shared package.
const requiredSchemaVersion int64 = 2

func schemaVersion(db *sql.DB) (int64, error) {
	var exists bool
	if err := db.QueryRow(
		`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'goose_db_version')`,
	).Scan(&exists); err != nil {
		return 0, err
	}
	if !exists {
		return 0, nil
	}
	var v sql.NullInt64
	err := db.QueryRow(`SELECT version_id FROM goose_db_version WHERE is_applied ORDER BY id DESC LIMIT 1`).Scan(&v)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return v.Int64, err
}

// waitForSchema polls until the database is at least at the required version
// or the timeout passes.
func waitForSchema(db *sql.DB, required int64, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		v, err := schemaVersion(db)
		if err == nil && v >= required {
			return nil
		}
		if time.Now().After(deadline) {
			if err != nil {
				return fmt.Errorf("schema version check: %w", err)
			}
			return fmt.Errorf("schema version %d required, database is at %d — run the auth-service migrations first", required, v)
		}
		time.Sleep(2 * time.Second)
	}
}

func (r *ModelConfigReconciler) ensureDB() error {
	r.dbOnce.Do(func() {
		url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
		if url == "" {
			r.dbErr = fmt.Errorf("DATABASE_URL is required")
			return
		}
		url = normalizeDBURL(url)
		db, err := sql.Open("pgx", url)
		if err != nil {
			r.dbErr = err
			return
		}
		r.db = db
		// The model_configs table is owned by auth-service's migrations
		// (services/pkg/dbmigrate); wait for the version this build needs.
		r.dbErr = waitForSchema(db, requiredSchemaVersion, 60*time.Second)
	})
	if r.db == nil && r.dbErr == nil {
		r.dbErr = fmt.Errorf("database not initialized")
	}
	return r.dbErr
}

func normalizeDBURL(url string) string {
	if strings.HasPrefix(url, "postgresql+asyncpg://") {
		return strings.Replace(url, "postgresql+asyncpg://", "postgresql://", 1)
	}
	return url
}

func (r *ModelConfigReconciler) upsertModelConfig(ctx context.Context, data modelConfigData) (int64, error) {
	if data.IsDefault {
		if _, err := r.db.ExecContext(ctx, "UPDATE model_configs SET is_default = FALSE WHERE name <> $1", data.Name); err != nil {
			return 0, err
		}
	}

	extraHeaders, err := json.Marshal(data.ExtraHeaders)
	if err != nil {
		return 0, err
	}

	// options: nil 이면 SQL NULL 로 저장 (JSONB), 값이 있으면 마샬링.
	var optionsArg interface{}
	if len(data.Options) > 0 {
		optionsJSON, err := json.Marshal(data.Options)
		if err != nil {
			return 0, err
		}
		optionsArg = optionsJSON
	}

	// ca_cert: 빈 문자열이면 SQL NULL.
	var caCertArg interface{}
	if strings.TrimSpace(data.CACert) != "" {
		caCertArg = data.CACert
	}

	query := `
INSERT INTO model_configs (
  name, provider, model, base_url,
  api_key_secret_name, api_key_secret_key, api_key_env,
  extra_headers, tls_verify, ca_cert, options, enabled, is_default,
  created_at, updated_at
) VALUES (
  $1, $2, $3, $4,
  $5, $6, $7,
  $8, $9, $10, $11, $12, $13,
  NOW(), NOW()
) ON CONFLICT (name) DO UPDATE SET
  provider = EXCLUDED.provider,
  model = EXCLUDED.model,
  base_url = EXCLUDED.base_url,
  api_key_secret_name = EXCLUDED.api_key_secret_name,
  api_key_secret_key = EXCLUDED.api_key_secret_key,
  api_key_env = EXCLUDED.api_key_env,
  extra_headers = EXCLUDED.extra_headers,
  tls_verify = EXCLUDED.tls_verify,
  ca_cert = EXCLUDED.ca_cert,
  options = EXCLUDED.options,
  enabled = EXCLUDED.enabled,
  is_default = EXCLUDED.is_default,
  updated_at = NOW()
RETURNING id;
`
	var id int64
	if err := r.db.QueryRowContext(ctx, query,
		data.Name,
		data.Provider,
		data.Model,
		data.BaseURL,
		data.SecretName,
		data.SecretKey,
		data.APIKeyEnv,
		extraHeaders,
		data.TLSVerify,
		caCertArg,
		optionsArg,
		data.Enabled,
		data.IsDefault,
	).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func (r *ModelConfigReconciler) deleteModelConfig(ctx context.Context, nn types.NamespacedName) (ctrl.Result, error) {
	if err := r.ensureDB(); err != nil {
		return ctrl.Result{RequeueAfter: 10 * time.Second}, err
	}
	_, err := r.db.ExecContext(ctx, "DELETE FROM model_configs WHERE name = $1", nn.Name)
	return ctrl.Result{}, err
}
