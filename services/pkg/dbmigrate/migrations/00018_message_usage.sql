-- +goose Up
-- Token usage of the chat turn an assistant message answered (prompt, completion
-- and cached tokens, model calls, model), shown under the answer. NULL when the
-- provider reported no usage, and for user messages.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS usage JSONB;

-- +goose Down
ALTER TABLE messages DROP COLUMN IF EXISTS usage;
