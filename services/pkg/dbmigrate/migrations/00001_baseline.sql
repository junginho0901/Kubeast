-- +goose Up
-- Baseline: the schema every service created at start-up before migrations
-- were versioned. Every statement is idempotent so an existing database
-- (created by the old CREATE TABLE IF NOT EXISTS code) passes through
-- unchanged and only records version 1; an empty database gets the full schema.

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR NOT NULL UNIQUE,
    description VARCHAR NOT NULL DEFAULT '',
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS role_permissions (
    id SERIAL PRIMARY KEY,
    role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission VARCHAR NOT NULL,
    UNIQUE(role_id, permission)
);
-- +goose StatementEnd

-- auth_users: created in its final shape (role_id, no legacy role column).
-- Databases that still carry the legacy role column are converted in 00002.
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS auth_users (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    email VARCHAR NOT NULL UNIQUE,
    team VARCHAR,
    role_id INT REFERENCES roles(id),
    password_hash VARCHAR NOT NULL,
    token_version INT NOT NULL DEFAULT 0,
    auth_source VARCHAR NOT NULL DEFAULT 'password',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS team VARCHAR;
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS auth_source VARCHAR NOT NULL DEFAULT 'password';
ALTER TABLE auth_users DROP COLUMN IF EXISTS hq;

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS auth_audit_logs (
    id SERIAL PRIMARY KEY,
    service VARCHAR,
    action VARCHAR NOT NULL,
    actor_user_id VARCHAR,
    actor_email VARCHAR,
    target_user_id VARCHAR,
    target_email VARCHAR,
    target_type VARCHAR,
    target_id VARCHAR,
    before JSONB DEFAULT '{}',
    after JSONB DEFAULT '{}',
    request_ip VARCHAR,
    user_agent VARCHAR,
    request_id VARCHAR,
    path VARCHAR,
    cluster VARCHAR,
    namespace VARCHAR,
    result VARCHAR NOT NULL DEFAULT 'success',
    error TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd
ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS service VARCHAR;
ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS cluster VARCHAR;
ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS namespace VARCHAR;
ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS target_type VARCHAR;
ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS target_id VARCHAR;
ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS result VARCHAR NOT NULL DEFAULT 'success';
ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS error TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON auth_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON auth_audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON auth_audit_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_service ON auth_audit_logs (service);
CREATE INDEX IF NOT EXISTS idx_audit_target_id ON auth_audit_logs (target_id);

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS cluster_setup (
    id SERIAL PRIMARY KEY,
    mode VARCHAR NOT NULL,
    secret_name VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    type VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(type, name)
);
-- +goose StatementEnd
DELETE FROM organizations WHERE type = 'hq';

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS clusters (
    id                     VARCHAR PRIMARY KEY,
    display_name           VARCHAR NOT NULL,
    mode                   VARCHAR NOT NULL,
    kubeconfig_secret_name VARCHAR,
    api_server_url         VARCHAR,
    cluster_uid            VARCHAR,
    is_self_cluster        BOOLEAN NOT NULL DEFAULT FALSE,
    health_status          VARCHAR DEFAULT 'unknown',
    last_healthcheck_at    TIMESTAMP,
    created_by             VARCHAR NOT NULL DEFAULT '',
    created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS cluster_uid VARCHAR;
CREATE INDEX IF NOT EXISTS idx_clusters_self ON clusters(is_self_cluster);
CREATE INDEX IF NOT EXISTS idx_clusters_uid ON clusters(cluster_uid);

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS user_cluster_roles (
    user_id    VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    cluster_id VARCHAR NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    role_id    INT     NOT NULL REFERENCES roles(id),
    PRIMARY KEY (user_id, cluster_id)
);
-- +goose StatementEnd
CREATE INDEX IF NOT EXISTS idx_ucr_user ON user_cluster_roles(user_id);

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR PRIMARY KEY,
    user_id VARCHAR NOT NULL DEFAULT 'default',
    cluster_id VARCHAR,
    title VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cluster_id VARCHAR;
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user_cluster ON sessions(user_id, cluster_id);

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role VARCHAR NOT NULL,
    content TEXT NOT NULL,
    tool_calls JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS session_contexts (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    state JSONB NOT NULL DEFAULT '{}',
    cache JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd

-- ai-service write-tool approvals (created by its ORM before versioning; no DB
-- defaults — the application fills every column).
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS tool_approvals (
    id VARCHAR PRIMARY KEY,
    session_id VARCHAR NOT NULL REFERENCES sessions(id),
    user_id VARCHAR NOT NULL,
    user_email VARCHAR,
    cluster VARCHAR NOT NULL,
    tool VARCHAR NOT NULL,
    args JSON NOT NULL,
    status VARCHAR NOT NULL,
    result TEXT,
    created_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    decided_at TIMESTAMP
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS model_configs (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    base_url TEXT,
    api_key_secret_name TEXT,
    api_key_secret_key TEXT,
    api_key_env TEXT,
    extra_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    tls_verify BOOLEAN NOT NULL DEFAULT TRUE,
    ca_cert TEXT,
    options JSONB,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS ca_cert TEXT;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS options JSONB;
-- The plaintext api_key column of early versions: keys come from env now.
ALTER TABLE model_configs DROP COLUMN IF EXISTS api_key;

-- +goose Down
-- The baseline has no down migration: it describes the schema the code
-- already required before versioning started.
