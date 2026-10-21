package controller

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"sort"
	"strings"
)

// Audit rows for a ModelConfig CR reaching the database (docs/audit-log-plan.md
// §5-2 ai.model_config.sync), in the table the services write. A row is written
// only when the stored config changes (a reconcile that writes the same values
// says nothing), with the fields the API's ai.model_config.* rows keep — never
// a key, a header value or a CA.

const (
	auditActorID    = "system"
	auditActorEmail = "kubeast:model-config-controller"
)

// configView is what a row keeps of a model config.
type configView map[string]any

func viewOf(d modelConfigData) configView {
	v := configView{"provider": d.Provider, "model": d.Model, "base_url": d.BaseURL, "api_key_env": d.APIKeyEnv,
		"api_key_secret_name": d.SecretName, "api_key_secret_key": d.SecretKey, "tls_verify": d.TLSVerify,
		"enabled": d.Enabled, "is_default": d.IsDefault, "tier": d.Tier}
	headers := make([]string, 0, len(d.ExtraHeaders))
	pairs := make([]string, 0, len(d.ExtraHeaders))
	for k, val := range d.ExtraHeaders {
		headers = append(headers, k)
		pairs = append(pairs, k+"="+val)
	}
	sort.Strings(headers)
	sort.Strings(pairs)
	v["extra_headers"] = headers
	// a changed header value or CA changes the row, without the value in it
	v["extra_headers_sha256"] = shortHash(strings.Join(pairs, "\n"))
	v["ca_cert_sha256"] = shortHash(strings.TrimSpace(d.CACert))
	return v
}

func shortHash(s string) string {
	if s == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:6])
}

// changed reports whether writing next over stored changes what a row keeps
// (stored nil = no row yet).
func changed(stored, next configView) bool {
	return stored == nil || !reflect.DeepEqual(stored, next)
}

// storedView reads the stored config's view, nil when there is none.
func (r *ModelConfigReconciler) storedView(ctx context.Context, name string) (configView, error) {
	var d modelConfigData
	var headers []byte
	err := r.db.QueryRowContext(ctx, `SELECT provider, model, COALESCE(base_url, ''), COALESCE(api_key_env, ''),
  COALESCE(api_key_secret_name, ''), COALESCE(api_key_secret_key, ''), tls_verify, enabled, is_default, tier, extra_headers,
  COALESCE(ca_cert, '')
FROM model_configs WHERE name = $1`, name).Scan(&d.Provider, &d.Model, &d.BaseURL, &d.APIKeyEnv, &d.SecretName, &d.SecretKey,
		&d.TLSVerify, &d.Enabled, &d.IsDefault, &d.Tier, &headers, &d.CACert)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(headers, &d.ExtraHeaders)
	return viewOf(d), nil
}

// recordSync writes one ai.model_config.sync row; a failed write is logged.
func (r *ModelConfigReconciler) recordSync(ctx context.Context, name, op string, before, after configView, opErr error) {
	body := map[string]any{"op": op}
	if before != nil {
		body["before"] = before
	}
	if after != nil {
		body["after"] = after
	}
	raw, _ := json.Marshal(body)
	result, msg := "success", ""
	if opErr != nil {
		result, msg = "failure", opErr.Error()
	}
	if _, err := r.db.ExecContext(ctx, `INSERT INTO auth_audit_logs
  (service, action, actor_user_id, actor_email, target_type, target_id, after, result, error)
VALUES ('ai', 'ai.model_config.sync', $1, $2, 'model_config', $3, $4, $5, NULLIF($6, ''))`,
		auditActorID, auditActorEmail, name, raw, result, msg); err != nil {
		slog.Error("model config audit write failed", "name", name, "op", op, "error", err)
	}
}
