-- +goose Up
-- A self sign-up (auth_source password) that a provider's sign-in reached while it waited for approval lost its
-- password there (auth-service endSelfSignUpCredentials, a user.account.link row) and stayed a password account, so an
-- admin's reset could give it a password again and the password form opened it with that password. auth-service now
-- makes such an account an oidc account at that sign-in.
--
-- self_signed_up marks the accounts the sign-up form made (auth-service Register sets it). An account an admin made (the
-- user form, the bulk form, the chart's admin at boot, reset-admin) is not marked, whatever its role, Pending included:
-- a provider's sign-in never takes it over, and its password stays the way in while the provider is down. The accounts
-- made before are marked here from their successful user.register row. One whose row the audit retention purge already
-- removed is not marked and stays as it is, a password account.
--
-- The marked accounts a provider's sign-in reached before are then made oidc, once: a password account holding no
-- password, which only that sign-in leaves, and one a user.account.link row names, which an admin's reset may have given
-- a password since. A password such an account holds stays, as one an admin's reset gave an account the provider made
-- stays: the password form refuses it, and a build before reads the account as it did. The tokens of an account holding
-- a password end (token_version + 1), so a session that password opened does not go on. Each change leaves a
-- user.account.link row by actor system / migration, before = {auth_source: password}, after = {auth_source: oidc,
-- reason: self_sign_up_reached_by_provider, password_held, sessions_ended}, unsealed, which the audit chain seals as any
-- other.
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS self_signed_up BOOLEAN NOT NULL DEFAULT false;

UPDATE auth_users u
   SET self_signed_up = true
 WHERE EXISTS (SELECT 1 FROM auth_audit_logs a
                WHERE a.action = 'user.register' AND a.result = 'success' AND a.target_user_id = u.id);

-- +goose StatementBegin
WITH moved AS (
    UPDATE auth_users u
       SET auth_source = 'oidc', updated_at = NOW(),
           token_version = u.token_version + CASE WHEN u.password_hash <> '' THEN 1 ELSE 0 END
     WHERE u.auth_source = 'password' AND u.self_signed_up
       AND (u.password_hash = ''
            OR EXISTS (SELECT 1 FROM auth_audit_logs a
                        WHERE a.action = 'user.account.link' AND a.result = 'success' AND a.target_user_id = u.id))
    RETURNING u.id, u.email, u.password_hash <> '' AS password_held
)
INSERT INTO auth_audit_logs (service, action, actor_user_id, actor_email, target_user_id, target_email, target_type, target_id, before, after, result)
SELECT 'auth', 'user.account.link', 'system', 'migration', id, email, 'user', id,
       jsonb_build_object('auth_source', 'password'),
       jsonb_build_object('auth_source', 'oidc', 'reason', 'self_sign_up_reached_by_provider', 'password_held', password_held,
                          'sessions_ended', password_held),
       'success'
  FROM moved;
-- +goose StatementEnd

-- +goose Down
-- The accounts moved to oidc are not moved back: an account moved here is one the provider took over, and nothing tells
-- it from one the provider made. A build before reads auth_source only to label it (Users, Account, Access review, the
-- waiting page) and to keep a provider's name that is no address off a password account holding a password; it signs
-- such an account in with a password it holds and resets it, as before this migration. self_signed_up goes, and Up
-- again marks the accounts from their user.register rows once more.
ALTER TABLE auth_users DROP COLUMN IF EXISTS self_signed_up;
