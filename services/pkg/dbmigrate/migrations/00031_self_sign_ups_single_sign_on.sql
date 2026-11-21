-- +goose Up
-- A self sign-up (auth_source password) that a provider's sign-in reached while it waited for approval lost its
-- password there (auth-service endSelfSignUpCredentials, a user.account.link row) and stayed a password account, so an
-- admin's reset could give it a password again and the password form opened it with that password. auth-service now
-- makes such an account an oidc account at that sign-in; the accounts reached so before are made so here, once: a
-- password account holding no password, which only that sign-in leaves, and one a user.account.link row names, which
-- an admin's reset may have given a password since. A password such an account holds stays, as one an admin's reset
-- gave an account the provider made stays: the password form refuses it, and a build before reads the account as it
-- did. An account an admin made or approved before the provider's sign-in reached it is not touched. Each change leaves
-- a user.account.link row by actor system / migration, before = {auth_source: password}, after = {auth_source: oidc,
-- reason: self_sign_up_reached_by_provider, password_held}, unsealed, which the audit chain seals as any other.

-- +goose StatementBegin
WITH moved AS (
    UPDATE auth_users u
       SET auth_source = 'oidc', updated_at = NOW()
     WHERE u.auth_source = 'password'
       AND (u.password_hash = ''
            OR EXISTS (SELECT 1 FROM auth_audit_logs a
                        WHERE a.action = 'user.account.link' AND a.result = 'success' AND a.target_user_id = u.id))
    RETURNING u.id, u.email, u.password_hash <> '' AS password_held
)
INSERT INTO auth_audit_logs (service, action, actor_user_id, actor_email, target_user_id, target_email, target_type, target_id, before, after, result)
SELECT 'auth', 'user.account.link', 'system', 'migration', id, email, 'user', id,
       jsonb_build_object('auth_source', 'password'),
       jsonb_build_object('auth_source', 'oidc', 'reason', 'self_sign_up_reached_by_provider', 'password_held', password_held),
       'success'
  FROM moved;
-- +goose StatementEnd

-- +goose Down
-- Not reversed: an account moved here is one the provider took over, and nothing tells it from one the provider made.
-- A build before reads auth_source only to label it (Users, Account, Access review, the waiting page) and to keep a
-- provider's name that is no address off a password account holding a password; it signs such an account in with a
-- password it holds and resets it, as before this migration.
