-- +goose Up
-- Dormant accounts (auth-service): the sweeper sets dormant_locked_at on an
-- account with no sign-in or API key use for DORMANT_ACCOUNTS_DAYS; an admin
-- clears it (unlock). Separate from locked_until, the temporary password lock.
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS dormant_locked_at TIMESTAMP;

-- +goose Down
ALTER TABLE auth_users DROP COLUMN IF EXISTS dormant_locked_at;
