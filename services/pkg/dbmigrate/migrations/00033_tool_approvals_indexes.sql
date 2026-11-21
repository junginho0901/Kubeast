-- +goose Up
-- tool_approvals had only its primary key, and it keeps every card while
-- retention.chatDays is 0.
-- (status, decided_at): ai-service's sweeps before each new card, the waiting
-- calls past expires_at (status = 'pending', all with decided_at NULL) and
-- the approved runs that never wrote their outcome (status = 'approved' AND
-- decided_at < now - 600 s ORDER BY decided_at).
-- (session_id): session-service DeleteSession, ai-service's card list of a
-- chat, the retention join on sessions, and the foreign key check each
-- DELETE FROM sessions runs on this table.
-- Built inside the migration's transaction like the other indexes here: the
-- build holds writes to tool_approvals, reads go on.
CREATE INDEX IF NOT EXISTS idx_tool_approvals_status_decided_at ON tool_approvals(status, decided_at);
CREATE INDEX IF NOT EXISTS idx_tool_approvals_session_id ON tool_approvals(session_id);

-- +goose Down
DROP INDEX IF EXISTS idx_tool_approvals_session_id;
DROP INDEX IF EXISTS idx_tool_approvals_status_decided_at;
