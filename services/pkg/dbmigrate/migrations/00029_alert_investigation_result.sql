-- +goose Up
-- What ai-service read of an alert investigation's rca block (features.alertInvestigation.ledger):
-- the causes, the path from cause to symptom, what was ruled out, whether there is a fault and the
-- hypothesis ledger, each call number given with its tool. NULL for a run without the switch.
ALTER TABLE alert_investigations ADD COLUMN IF NOT EXISTS result JSONB;

-- +goose Down
ALTER TABLE alert_investigations DROP COLUMN IF EXISTS result;
