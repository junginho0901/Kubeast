-- +goose Up
-- How many times a stopping ai-service put this running investigation back in the
-- queue (ai-service runner.requeue_on_stop). The first stop requeues it; a run cut
-- again while it already went back once ends failed ("the server stopped twice").
ALTER TABLE alert_investigations ADD COLUMN IF NOT EXISTS stop_requeues INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE alert_investigations DROP COLUMN IF EXISTS stop_requeues;
