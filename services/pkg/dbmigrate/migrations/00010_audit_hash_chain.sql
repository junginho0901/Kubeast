-- +goose Up
-- Audit log integrity (auth-service, internal/auditchain): the sealer chains
-- auth_audit_logs rows in sealing order — chain_seq is the position,
-- row_hash = sha256(prev_hash || 0x1e || canonical row) — and audit_anchors
-- keeps every digest written to the anchor sink so a verifier can compare.
ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS chain_seq BIGINT;
ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS prev_hash BYTEA;
ALTER TABLE auth_audit_logs ADD COLUMN IF NOT EXISTS row_hash BYTEA;
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_audit_logs_chain_seq ON auth_audit_logs(chain_seq) WHERE chain_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_unsealed ON auth_audit_logs(id) WHERE chain_seq IS NULL;
CREATE TABLE IF NOT EXISTS audit_anchors (
    id               BIGSERIAL PRIMARY KEY,
    created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    from_seq         BIGINT NOT NULL,
    to_seq           BIGINT NOT NULL,
    row_count        BIGINT NOT NULL,
    head_hash        BYTEA NOT NULL,
    prev_anchor_hash BYTEA,
    anchor_hash      BYTEA NOT NULL,
    sink             VARCHAR NOT NULL,
    object_key       VARCHAR NOT NULL,
    actor            VARCHAR NOT NULL
);

-- +goose Down
DROP TABLE IF EXISTS audit_anchors;
DROP INDEX IF EXISTS idx_auth_audit_logs_unsealed;
DROP INDEX IF EXISTS idx_auth_audit_logs_chain_seq;
ALTER TABLE auth_audit_logs DROP COLUMN IF EXISTS row_hash;
ALTER TABLE auth_audit_logs DROP COLUMN IF EXISTS prev_hash;
ALTER TABLE auth_audit_logs DROP COLUMN IF EXISTS chain_seq;
