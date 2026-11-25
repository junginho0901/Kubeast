-- +goose Up
-- The model config an administrator chose for a use of the AI (ai-service
-- app/services/model_uses.py): one row per use that has a choice. A use
-- without a row runs on the config it ran on before this table. Deleting a
-- config, on the screen or with its ModelConfig resource, takes its choices
-- with it. Nothing here changes model_configs: its updated_at orders which
-- config is active when none is the default.
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS model_uses (
    use_name  VARCHAR PRIMARY KEY,
    config_id INTEGER NOT NULL REFERENCES model_configs(id) ON DELETE CASCADE
);
-- +goose StatementEnd

-- +goose Down
DROP TABLE IF EXISTS model_uses;
