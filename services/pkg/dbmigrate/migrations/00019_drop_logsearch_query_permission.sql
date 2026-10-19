-- +goose Up
-- admin.logsearch.query is gone: the screen's LogQL is open to anyone who may
-- search logs (features.logSearch.logql). Roles that still name it could no
-- longer be saved (unknown permission), so it leaves them here.
DELETE FROM role_permissions WHERE permission = 'admin.logsearch.query';

-- +goose Down
-- Nothing to restore: which roles held the permission is not kept.
SELECT 1;
