-- +goose Up
-- Node drains (k8s-service POST /api/v1/nodes/{name}/drain): what the drain
-- window reads, so any k8s-service replica answers a drain's status. The
-- process running the drain (owner: its host name and a random suffix) writes
-- the progress and refreshes heartbeat_at while it runs. An open row
-- (finished_at NULL) whose heartbeat has gone stale has no live server: the
-- first replica to see it marks it interrupted with one conditional UPDATE and
-- writes the drain's finished audit row from audit (the start request's
-- audit record, without payload). k8s-service deletes finished rows a day
-- after finished_at; the drain's history is in auth_audit_logs.
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS node_drains (
    id           VARCHAR     PRIMARY KEY,
    cluster      VARCHAR     NOT NULL,
    node         VARCHAR     NOT NULL,
    user_id      VARCHAR,
    user_email   VARCHAR,
    status       VARCHAR     NOT NULL,
    message      TEXT,
    pods_total   INTEGER,
    pods_done    INTEGER,
    owner        VARCHAR     NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    audit        JSONB,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at  TIMESTAMPTZ
);
-- +goose StatementEnd
CREATE INDEX IF NOT EXISTS idx_node_drains_open ON node_drains(heartbeat_at) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_node_drains_finished_at ON node_drains(finished_at);

-- +goose Down
DROP TABLE IF EXISTS node_drains;
