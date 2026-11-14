-- +goose Up
-- The k8s-service process writing a recording (owner: its host name and a
-- random suffix) and when it last said it still holds it (heartbeat_at, every
-- 15 s; NULL once it handed the row over at shutdown). Recovery takes a row
-- only when no live process holds it, so a server starting beside another (a
-- rolling update) leaves the other's recordings alone. Both are nullable with
-- no default: rows written before have neither, and a server of the build
-- before, which names its columns, writes rows as it did.
ALTER TABLE session_recordings ADD COLUMN IF NOT EXISTS owner VARCHAR;
ALTER TABLE session_recordings ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP;

-- +goose Down
ALTER TABLE session_recordings DROP COLUMN IF EXISTS heartbeat_at;
ALTER TABLE session_recordings DROP COLUMN IF EXISTS owner;
