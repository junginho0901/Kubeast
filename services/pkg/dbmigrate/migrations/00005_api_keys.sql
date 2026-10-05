-- +goose Up
-- API keys (auth-service): a long-lived credential a user issues for
-- automation. Only the SHA-256 of the key is stored; the value is shown once,
-- at creation. A key is exchanged for a short access token (POST /auth/token)
-- narrowed to cluster_ids (NULL = every cluster the user reaches) and
-- role_ceiling; the user's own permissions at exchange time are the upper
-- bound. Revoking deletes the row (the audit log keeps the history).
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS api_keys (
    id           VARCHAR PRIMARY KEY,
    user_id      VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    name         VARCHAR NOT NULL,
    key_hash     VARCHAR NOT NULL UNIQUE,
    key_prefix   VARCHAR NOT NULL,
    cluster_ids  TEXT[],
    role_ceiling VARCHAR NOT NULL DEFAULT 'Read',
    expires_at   TIMESTAMP NOT NULL,
    last_used_at TIMESTAMP,
    last_used_ip VARCHAR,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS api_keys;
