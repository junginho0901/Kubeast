-- +goose Up
-- Per-cluster Prometheus Service ("namespace/service:port") reached through the
-- API server proxy instead of discovery. NULL = discover (or the external URL).
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS prometheus_service VARCHAR;

-- +goose Down
ALTER TABLE clusters DROP COLUMN IF EXISTS prometheus_service;
