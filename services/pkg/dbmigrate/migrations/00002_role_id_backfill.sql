-- +goose Up
-- Convert databases that still carry the legacy auth_users.role string
-- column to role_id (the four original system roles plus Member). Runs to
-- completion on such a database and is a no-op on the current shape.
-- Permissions of the system roles are owned by auth-service (SeedSystemRoles),
-- which runs after migrations; only the role rows needed for the mapping are
-- inserted here.

-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'auth_users' AND column_name = 'role'
    ) THEN
        INSERT INTO roles (name, description, is_system) VALUES
            ('Pending', '승인 대기', true),
            ('Member', '일반 사용자 (클러스터별 권한으로 접근)', true),
            ('Read', '읽기 전용', true),
            ('Write', '읽기/쓰기', true),
            ('Admin', '전체 관리자', true)
        ON CONFLICT (name) DO NOTHING;

        ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS role_id INT REFERENCES roles(id);

        UPDATE auth_users SET role_id = (SELECT id FROM roles WHERE name = 'Pending') WHERE role = 'pending' AND role_id IS NULL;
        UPDATE auth_users SET role_id = (SELECT id FROM roles WHERE name = 'Read')    WHERE role = 'read'    AND role_id IS NULL;
        UPDATE auth_users SET role_id = (SELECT id FROM roles WHERE name = 'Write')   WHERE role = 'write'   AND role_id IS NULL;
        UPDATE auth_users SET role_id = (SELECT id FROM roles WHERE name = 'Admin')   WHERE role = 'admin'   AND role_id IS NULL;
        UPDATE auth_users SET role_id = (SELECT id FROM roles WHERE name = 'Read')    WHERE role_id IS NULL;

        ALTER TABLE auth_users ALTER COLUMN role_id SET NOT NULL;
        ALTER TABLE auth_users DROP COLUMN role;
    END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- Not reversible: the legacy role column is gone once converted.
