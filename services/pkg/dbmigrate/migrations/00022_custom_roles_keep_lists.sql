-- +goose Up
-- k8s-service's lists and details now ask resource.objects.read. A custom role made before this read them (the role's
-- group on the cluster decided), so it keeps them here. Not resource.*.read: that would open what the role cannot read
-- today, Pod logs, Helm, Cost. A role with no permission reaches no cluster and stays so, and a wildcard already holds
-- the key. A role of admin.* keys alone opens pages, not clusters: it needs the key only where it is granted on one, and
-- without it an editor who holds no cluster key can still save that role.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'resource.objects.read'
FROM roles r
WHERE r.is_system = false
  AND (
    EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.permission NOT LIKE 'admin.%')
    OR (
      EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id)
      AND EXISTS (SELECT 1 FROM user_cluster_roles g WHERE g.role_id = r.id)
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions p
    WHERE p.role_id = r.id AND p.permission IN ('*', 'resource.*', 'resource.*.*', 'resource.*.read', 'resource.objects.*')
  )
ON CONFLICT (role_id, permission) DO NOTHING;

-- A token issued before this does not hold the key: its owner signs in once, as when a role is edited.
UPDATE auth_users SET token_version = token_version + 1, updated_at = NOW()
WHERE id IN (
  SELECT g.user_id FROM user_cluster_roles g
  JOIN role_permissions p ON p.role_id = g.role_id
  WHERE p.permission = 'resource.objects.read'
);

-- +goose Down
-- An older build refuses to save a role holding a key it does not know.
DELETE FROM role_permissions WHERE permission = 'resource.objects.read';
