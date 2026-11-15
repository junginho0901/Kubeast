-- +goose Up
-- Signed-out sign-ins (auth-service POST /auth/logout). A sign-in is a user
-- and the auth_time its tokens carry: unix seconds, set when the user signs
-- in and kept through every refresh, so two sign-ins of one user in the same
-- second are one row. While a row is here, refresh refuses that sign-in's
-- tokens, the services refuse its requests and an open terminal, followed log
-- or live list of it ends at its next check (services/pkg/auth
-- SessionStateQuery). After a sign-out no token of the sign-in is issued, so
-- auth-service deletes the row once the token lifetime and a margin for the
-- services' checks have passed since ended_at.
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS ended_sign_ins (
    user_id   VARCHAR     NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    auth_time BIGINT      NOT NULL,
    ended_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, auth_time)
);
-- +goose StatementEnd
CREATE INDEX IF NOT EXISTS idx_ended_sign_ins_ended_at ON ended_sign_ins(ended_at);

-- +goose Down
DROP TABLE IF EXISTS ended_sign_ins;
