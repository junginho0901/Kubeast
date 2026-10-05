-- +goose Up
-- Terminal session recordings (k8s-service internal/recording): one row per
-- recorded pod exec or node shell. The asciicast body lives in the configured
-- store (S3-compatible, files, or session_recording_parts below) as ordered
-- parts uploaded during the session; this row is the index the console lists
-- and the uploader resumes from.
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS session_recordings (
    id             VARCHAR PRIMARY KEY,
    kind           VARCHAR   NOT NULL,          -- exec | node-shell
    user_id        VARCHAR,
    user_email     VARCHAR,
    cluster        VARCHAR   NOT NULL,
    namespace      VARCHAR,
    target         VARCHAR   NOT NULL,          -- pod or node name
    container      VARCHAR,
    storage        VARCHAR   NOT NULL,          -- s3 | database | file
    location       VARCHAR   NOT NULL DEFAULT '', -- key prefix / directory of the parts
    started_at     TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at       TIMESTAMP,
    bytes          BIGINT    NOT NULL DEFAULT 0, -- written locally
    uploaded_bytes BIGINT    NOT NULL DEFAULT 0,
    parts          INT       NOT NULL DEFAULT 0,
    status         VARCHAR   NOT NULL DEFAULT 'recording', -- recording | uploading | uploaded | interrupted
    truncated      BOOLEAN   NOT NULL DEFAULT FALSE,
    last_error     TEXT,
    updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);
-- +goose StatementEnd
CREATE INDEX IF NOT EXISTS idx_session_recordings_started ON session_recordings(started_at);
CREATE INDEX IF NOT EXISTS idx_session_recordings_status ON session_recordings(status) WHERE status <> 'uploaded';

-- Parts for the database store (small installs without S3).
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS session_recording_parts (
    recording_id VARCHAR NOT NULL REFERENCES session_recordings(id) ON DELETE CASCADE,
    part_no      INT     NOT NULL,
    data         BYTEA   NOT NULL,
    PRIMARY KEY (recording_id, part_no)
);
-- +goose StatementEnd

-- +goose Down
DROP TABLE IF EXISTS session_recording_parts;
DROP TABLE IF EXISTS session_recordings;
