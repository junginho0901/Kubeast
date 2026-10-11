-- +goose Up
-- Per-cluster Prometheus source: an external (central) store's URL, the name
-- of the Secret holding its Authorization header, and the value of the
-- cluster label its series carry. NULL = find Prometheus inside the cluster.
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS prometheus_url VARCHAR;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS prometheus_auth_secret_name VARCHAR;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS prometheus_cluster_label VARCHAR;

-- +goose Down
ALTER TABLE clusters DROP COLUMN IF EXISTS prometheus_cluster_label;
ALTER TABLE clusters DROP COLUMN IF EXISTS prometheus_auth_secret_name;
ALTER TABLE clusters DROP COLUMN IF EXISTS prometheus_url;
