-- +goose Up
-- config_version: what k8s-service builds a cluster's connection from, as one
-- number. auth-service sets a new value in the statement that changes that
-- (kubeconfig replaced, Prometheus or log store settings), and a deleted
-- cluster has no row. Every k8s-service process reads (id, config_version)
-- of all clusters every few seconds and drops a connection built from another
-- value (internal/clustersync), so a change reaches every process even when
-- auth-service's call to one of them or the Redis notice is lost.
-- updated_at cannot serve: the health check rewrites it every minute.
--
-- Values come from a sequence, so a cluster deleted and registered again
-- under the same id never shows a value a process built from before. The
-- column is added with a constant default (no table rewrite, rows written
-- before read 0); new rows take the sequence afterwards.
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS config_version BIGINT NOT NULL DEFAULT 0;
CREATE SEQUENCE IF NOT EXISTS cluster_config_version_seq OWNED BY clusters.config_version;
ALTER TABLE clusters ALTER COLUMN config_version SET DEFAULT nextval('cluster_config_version_seq');

-- +goose Down
ALTER TABLE clusters DROP COLUMN IF EXISTS config_version;
DROP SEQUENCE IF EXISTS cluster_config_version_seq;
