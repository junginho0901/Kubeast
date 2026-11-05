-- +goose Up
-- Who asked for an alert investigation from the Alerts inbox ("Investigate now",
-- ai-service features.alertInvestigation.manual): the person's email, '' for one
-- the webhook queued. The daily token budgets count the two apart and the hourly
-- cap counts the webhook's only.
ALTER TABLE alert_investigations ADD COLUMN IF NOT EXISTS requested_by VARCHAR NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE alert_investigations DROP COLUMN IF EXISTS requested_by;
