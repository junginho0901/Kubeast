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
		r.dbErr = r.ensureTable()
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

func (r *ModelConfigReconciler) ensureTable() error {
	ddl := `
CREATE TABLE IF NOT EXISTS model_configs (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  base_url TEXT,
  api_key_secret_name TEXT,
  api_key_secret_key TEXT,
  api_key_env TEXT,
  extra_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  tls_verify BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`
	_, err := r.db.Exec(ddl)
	return err
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

	query := `
INSERT INTO model_configs (
  name, provider, model, base_url,
  api_key_secret_name, api_key_secret_key, api_key_env,
  extra_headers, tls_verify, enabled, is_default,
  created_at, updated_at
) VALUES (
  $1, $2, $3, $4,
  $5, $6, $7,
  $8, $9, $10, $11,
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
