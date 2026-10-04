-- +goose Up
-- Temporary per-cluster grants and the requests that create them (auth-service
-- access requests). A grant with expires_at is temporary: the sweeper restores
-- restore_role_id (or deletes the row when NULL) once it passes, and the token
-- issuance queries ignore it from then on. request_id links the grant to the
-- request it came from so the request can be closed when the grant ends.
ALTER TABLE user_cluster_roles ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE user_cluster_roles ADD COLUMN IF NOT EXISTS restore_role_id INT REFERENCES roles(id);
ALTER TABLE user_cluster_roles ADD COLUMN IF NOT EXISTS request_id VARCHAR;
CREATE INDEX IF NOT EXISTS idx_ucr_expires ON user_cluster_roles(expires_at) WHERE expires_at IS NOT NULL;

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS access_requests (
    id               VARCHAR PRIMARY KEY,
    user_id          VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    cluster_id       VARCHAR NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    role_id          INT     NOT NULL REFERENCES roles(id),
    duration_minutes INT     NOT NULL,
    reason           TEXT    NOT NULL,
    status           VARCHAR NOT NULL DEFAULT 'pending',
    created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    decided_by       VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
    decided_at       TIMESTAMP,
    decision_note    TEXT,
    expires_at       TIMESTAMP,
    ended_at         TIMESTAMP,
    end_reason       VARCHAR
);
-- +goose StatementEnd
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_access_requests_user ON access_requests(user_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS access_requests;
DROP INDEX IF EXISTS idx_ucr_expires;
ALTER TABLE user_cluster_roles DROP COLUMN IF EXISTS request_id;
ALTER TABLE user_cluster_roles DROP COLUMN IF EXISTS restore_role_id;
ALTER TABLE user_cluster_roles DROP COLUMN IF EXISTS expires_at;
