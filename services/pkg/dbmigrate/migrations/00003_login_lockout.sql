-- +goose Up
-- Login failure counter and temporary lockout (auth-service Login):
-- failed_logins counts password failures inside the observation window that
-- started at last_failed_login; reaching LOGIN_MAX_FAILURES sets locked_until.
-- A successful login resets all three.
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS failed_logins INT NOT NULL DEFAULT 0;
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS last_failed_login TIMESTAMP;
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;

-- +goose Down
ALTER TABLE auth_users DROP COLUMN IF EXISTS locked_until;
ALTER TABLE auth_users DROP COLUMN IF EXISTS last_failed_login;
ALTER TABLE auth_users DROP COLUMN IF EXISTS failed_logins;
