-- +goose Up
-- Alert inbox (ai-service, features.alertInvestigation): one row per alert
-- Alertmanager sent, firing or resolved, every severity. The key is cluster +
-- fingerprint + starts_at: Alertmanager keeps starts_at while an alert goes on
-- firing, and an alert that fires again after it resolved comes with a new one.
-- received_count counts the notifications (repeat_interval resends). The
-- acked/assignee/note/done columns are Kubeast's own handling marks; the state
-- changes only with what Alertmanager sends. Deleted with the investigations
-- after RETENTION_INVESTIGATION_DAYS by auth-service (last_received_at).
CREATE TABLE IF NOT EXISTS alert_inbox (
    id                VARCHAR PRIMARY KEY,
    cluster           VARCHAR NOT NULL,
    fingerprint       VARCHAR NOT NULL,
    starts_at         TIMESTAMP NOT NULL,
    alertname         VARCHAR NOT NULL DEFAULT '',
    severity          VARCHAR NOT NULL DEFAULT '',
    namespace         VARCHAR NOT NULL DEFAULT '',
    labels            JSONB NOT NULL DEFAULT '{}',
    annotations       JSONB NOT NULL DEFAULT '{}',
    state             VARCHAR NOT NULL,
    resolved_at       TIMESTAMP,
    first_received_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_received_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    received_count    INTEGER NOT NULL DEFAULT 1,
    generator_url     TEXT NOT NULL DEFAULT '',
    alertmanager_url  TEXT NOT NULL DEFAULT '',
    receiver          VARCHAR NOT NULL DEFAULT '',
    group_key         TEXT NOT NULL DEFAULT '',
    acked_by          VARCHAR NOT NULL DEFAULT '',
    acked_at          TIMESTAMP,
    assignee          VARCHAR NOT NULL DEFAULT '',
    note              TEXT NOT NULL DEFAULT '',
    note_by           VARCHAR NOT NULL DEFAULT '',
    note_at           TIMESTAMP,
    done_by           VARCHAR NOT NULL DEFAULT '',
    done_at           TIMESTAMP,
    CONSTRAINT alert_inbox_alert UNIQUE (cluster, fingerprint, starts_at)
);
CREATE INDEX IF NOT EXISTS idx_alert_inbox_cluster_received ON alert_inbox(cluster, last_received_at DESC);

-- +goose Down
DROP TABLE IF EXISTS alert_inbox;
