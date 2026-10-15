-- +goose Up
-- Per-cluster log store (log search): the URL of this cluster's own Loki, the
-- name of the Secret holding its Authorization header, its tenant
-- (X-Scope-OrgID) and the value of the cluster label its streams carry.
-- NULL = the deployment-wide store (features.logSearch).
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS log_search_url VARCHAR;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS log_search_auth_secret_name VARCHAR;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS log_search_tenant VARCHAR;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS log_search_cluster_label VARCHAR;

-- +goose Down
ALTER TABLE clusters DROP COLUMN IF EXISTS log_search_cluster_label;
ALTER TABLE clusters DROP COLUMN IF EXISTS log_search_tenant;
ALTER TABLE clusters DROP COLUMN IF EXISTS log_search_auth_secret_name;
ALTER TABLE clusters DROP COLUMN IF EXISTS log_search_url;
