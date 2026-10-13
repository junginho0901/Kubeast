-- +goose Up
-- Alert → AI investigation (ai-service, features.alertInvestigation): one row
-- per alert Alertmanager sent that passed the severity filter. status is
-- queued → running → done | failed, or skipped (hourly cap, token budget) with
-- skip_reason. A repeat of the same cluster + fingerprint within the dedupe
-- window bumps repeat_count / last_seen_at instead of a new row. The worker
-- claims queued rows with FOR UPDATE SKIP LOCKED. Deleted after
-- RETENTION_INVESTIGATION_DAYS by auth-service (the report can quote pod logs).
CREATE TABLE IF NOT EXISTS alert_investigations (
    id                VARCHAR PRIMARY KEY,
    cluster           VARCHAR NOT NULL,
    fingerprint       VARCHAR NOT NULL,
    alertname         VARCHAR NOT NULL DEFAULT '',
    severity          VARCHAR NOT NULL DEFAULT '',
    namespace         VARCHAR NOT NULL DEFAULT '',
    status            VARCHAR NOT NULL,
    skip_reason       VARCHAR NOT NULL DEFAULT '',
    labels            JSONB NOT NULL DEFAULT '{}',
    annotations       JSONB NOT NULL DEFAULT '{}',
    starts_at         TIMESTAMP,
    generator_url     TEXT NOT NULL DEFAULT '',
    alertmanager_url  TEXT NOT NULL DEFAULT '',
    group_key         TEXT NOT NULL DEFAULT '',
    received_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    started_at        TIMESTAMP,
    finished_at       TIMESTAMP,
    repeat_count      INTEGER NOT NULL DEFAULT 1,
    last_seen_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    provider          VARCHAR NOT NULL DEFAULT '',
    model             VARCHAR NOT NULL DEFAULT '',
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    iterations        INTEGER NOT NULL DEFAULT 0,
    tool_calls        JSONB NOT NULL DEFAULT '[]',
    report            TEXT NOT NULL DEFAULT '',
    error             TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_alert_investigations_dedupe ON alert_investigations(cluster, fingerprint, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_investigations_received ON alert_investigations(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_investigations_queued ON alert_investigations(received_at) WHERE status = 'queued';

-- +goose Down
DROP TABLE IF EXISTS alert_investigations;
