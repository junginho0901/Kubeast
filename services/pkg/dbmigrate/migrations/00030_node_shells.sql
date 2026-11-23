-- +goose Up
-- Node shells (k8s-service GET /api/v1/nodes/{name}/debug-shell/ws): one row
-- per open shell, written before its pod is made. The process that opened it
-- (owner: its host name and a random suffix, also the pod's annotation
-- kubeast.io/node-shell-owner) refreshes heartbeat_at while the shell runs and
-- deletes the row once the pod is gone. A row whose heartbeat has gone stale
-- has no live server: a k8s-service replica takes it with one conditional
-- UPDATE, deletes the pod (label kubeast.io/node-shell-id = id) in cluster as
-- the person in person (the opener's claims for that cluster), writes the
-- shell's k8s.session.end row from audit (the opening request's audit record,
-- without payload) and deletes the row. released_at: the owner gave the row up
-- after the shell ended without deleting the pod. A row opened longer ago than
-- the shell's deadline and its slack is dropped whatever its pod's delete gave.
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS node_shells (
    id           VARCHAR     PRIMARY KEY,
    cluster      VARCHAR     NOT NULL,
    namespace    VARCHAR     NOT NULL,
    pod          VARCHAR     NOT NULL,
    node         VARCHAR     NOT NULL,
    owner        VARCHAR     NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    person       JSONB,
    audit        JSONB,
    opened_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at  TIMESTAMPTZ
);
-- +goose StatementEnd
CREATE INDEX IF NOT EXISTS idx_node_shells_heartbeat_at ON node_shells(heartbeat_at);

-- +goose Down
DROP TABLE IF EXISTS node_shells;
