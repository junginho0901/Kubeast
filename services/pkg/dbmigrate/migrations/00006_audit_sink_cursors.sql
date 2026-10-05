-- +goose Up
-- Audit sinks (auth-service internal/auditsink): how far each configured sink
-- has copied auth_audit_logs. The dispatcher sends rows with id > last_id and
-- moves last_id after a successful send; retention keeps every row above the
-- lowest last_id of the configured sinks.
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS audit_sink_cursors (
    sink_name     VARCHAR PRIMARY KEY,
    last_id       BIGINT    NOT NULL DEFAULT 0,
    last_sent_at  TIMESTAMP,
    failures      INT       NOT NULL DEFAULT 0,
    last_error    TEXT,
    last_error_at TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd

-- +goose Down
DROP TABLE IF EXISTS audit_sink_cursors;
