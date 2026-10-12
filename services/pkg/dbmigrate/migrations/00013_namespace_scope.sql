-- +goose Up
-- Namespace-scoped grants: a per-cluster role limited to a list of namespaces
-- (NULL = the whole cluster, as before). An approved access request can carry
-- a list too; restore_namespaces remembers the permanent grant's list the way
-- restore_role_id remembers its role.
ALTER TABLE user_cluster_roles ADD COLUMN IF NOT EXISTS namespaces TEXT[];
ALTER TABLE user_cluster_roles ADD COLUMN IF NOT EXISTS restore_namespaces TEXT[];
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS namespaces TEXT[];

-- +goose Down
ALTER TABLE access_requests DROP COLUMN IF EXISTS namespaces;
ALTER TABLE user_cluster_roles DROP COLUMN IF EXISTS restore_namespaces;
ALTER TABLE user_cluster_roles DROP COLUMN IF EXISTS namespaces;
