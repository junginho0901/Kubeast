-- +goose Up
-- Access review (auth-service): auth_users.last_login_at is set on every
-- successful sign-in (password, OIDC) and backfilled here from the audit log;
-- access_reviews keeps each sign-off with the report as it stood.
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
-- +goose StatementBegin
UPDATE auth_users u SET last_login_at = l.last_at
  FROM (SELECT actor_user_id, MAX(created_at) AS last_at
          FROM auth_audit_logs
         WHERE action = 'user.login.success' AND actor_user_id IS NOT NULL
         GROUP BY actor_user_id) l
 WHERE u.id = l.actor_user_id AND u.last_login_at IS NULL;
-- +goose StatementEnd
CREATE TABLE IF NOT EXISTS access_reviews (
    id                VARCHAR PRIMARY KEY,
    reviewed_by       VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
    reviewed_by_email VARCHAR NOT NULL,
    reviewed_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    note              TEXT NOT NULL DEFAULT '',
    counts            JSONB NOT NULL DEFAULT '{}',
    snapshot          JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_access_reviews_at ON access_reviews(reviewed_at DESC);

-- +goose Down
DROP TABLE IF EXISTS access_reviews;
ALTER TABLE auth_users DROP COLUMN IF EXISTS last_login_at;
