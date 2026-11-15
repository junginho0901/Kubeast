-- +goose Up
-- The install-wide limit on Claude Code runs (ai-service, chart
-- ai.providers.claudeCode.maxConcurrentTotal), shared by every ai-service
-- replica: one row per lane and slot number, which ai-service adds as a limit
-- needs them. A run takes a slot whose owner is '' or whose heartbeat_at is
-- 60 s old with one conditional UPDATE, refreshes heartbeat_at every 15 s
-- while it runs and sets owner back to '' when it ends. No lock is held while
-- a run goes on: the slot of a server that stops goes stale and is taken again.
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS claude_code_slots (
    lane         VARCHAR     NOT NULL,
    slot         INTEGER     NOT NULL,
    owner        VARCHAR     NOT NULL DEFAULT '',
    heartbeat_at TIMESTAMPTZ,
    PRIMARY KEY (lane, slot)
);
-- +goose StatementEnd

-- +goose Down
DROP TABLE IF EXISTS claude_code_slots;
