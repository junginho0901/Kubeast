-- +goose Up
-- Model config tier: 'default' for the chat, or 'economy' — a cheaper model the
-- chat's history summaries and the floating assistant use when one is enabled.
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS tier VARCHAR NOT NULL DEFAULT 'default';

-- +goose Down
ALTER TABLE model_configs DROP COLUMN IF EXISTS tier;
