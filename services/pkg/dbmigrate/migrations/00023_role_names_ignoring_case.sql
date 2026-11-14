-- +goose Up
-- A role acts on a cluster as the group made from its name (auth.RoleGroupSlug), so two roles whose names make one
-- group share its bindings, and a custom role whose name makes a built-in's group (ADMIN, " read ") once acted as that
-- built-in. auth-service refuses such a name when a role is made or renamed; from here the database refuses it too,
-- with a unique index on the group each name makes. role_group_slug is auth.RoleGroupSlug written in SQL: Go's
-- whitespace trimmed, A-Z and the two letters Go lowers to ASCII (U+0130, U+212A) lowered, anything outside
-- [a-z0-9._-] made "-". It does not depend on the database's locale.
--
-- Roles stored before the rule are put right here, once. Of the roles of one group, the built-in (else the oldest)
-- keeps its name; every other one, and a custom role making a built-in's group where that built-in is not stored yet,
-- is renamed "<name>-renamed-<id>" and loses what it held on a cluster: its grants are removed (a temporary one goes
-- back to the grant it would restore), the restore of a temporary grant that would bring it back is dropped, its
-- pending and approved access requests end (end_reason role_renamed) and the holders' tokens end. Accounts whose
-- account level is such a role keep it under the new name, except a role of Pending's group (PENDING): the builds
-- before read the account level ignoring case and kept such an account waiting for approval, so it moves to the
-- built-in Pending, stored here when it is not yet. Each change leaves an audit row by actor system / migration,
-- unsealed, which the audit chain seals as any other.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION role_group_slug(role_name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT regexp_replace(
           translate(
             btrim(role_name, E' \t\n\u000b\f\r\u0085                 　'),
             E'ABCDEFGHIJKLMNOPQRSTUVWXYZİK',
             'abcdefghijklmnopqrstuvwxyzik'),
           '[^a-z0-9._-]', '-', 'g')
$$;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE
  ids       int[];
  olds      text[];
  keepers   text[];
  news      text[] := '{}';
  users     text[] := '{}';
  i         int;
  suffix    text;
  candidate text;
  n         int;
  g         record;
  pending   int;
BEGIN
  SELECT coalesce(array_agg(id ORDER BY id), '{}'), coalesce(array_agg(name ORDER BY id), '{}'), coalesce(array_agg(keeper ORDER BY id), '{}')
    INTO ids, olds, keepers
    FROM (
      SELECT ro.id, ro.name, b.name AS builtin_name,
             coalesce(ro.name = b.name, false) AS is_builtin,
             coalesce(b.name, first_value(ro.name) OVER w) AS keeper,
             row_number() OVER w AS place
        FROM roles ro
        LEFT JOIN (VALUES ('Pending', 'pending'), ('Member', 'member'), ('Read', 'read'), ('Write', 'write'), ('Admin', 'admin')) AS b(name, slug)
          ON b.slug = role_group_slug(ro.name)
      WINDOW w AS (PARTITION BY role_group_slug(ro.name) ORDER BY coalesce(ro.name = b.name, false) DESC, ro.is_system DESC, ro.id)
    ) grouped
   WHERE NOT is_builtin AND (place > 1 OR builtin_name IS NOT NULL);

  IF cardinality(ids) = 0 THEN
    RETURN;
  END IF;

  -- New names, in id order, each checked against every name stored at that moment. The old name is trimmed of the
  -- whitespace role_group_slug trims (Go's). 100 characters is the role form's limit.
  FOR i IN 1 .. cardinality(ids) LOOP
    suffix := '-renamed-' || ids[i];
    n := 1;
    LOOP
      candidate := left(btrim(olds[i], E' \t\n\u000b\f\r\u0085                 　'), 100 - length(suffix)) || suffix;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM roles WHERE id <> ids[i] AND role_group_slug(name) = role_group_slug(candidate));
      n := n + 1;
      suffix := '-renamed-' || ids[i] || '-' || n;
    END LOOP;
    UPDATE roles SET name = candidate, updated_at = NOW() WHERE id = ids[i];
    news := news || candidate;
    INSERT INTO auth_audit_logs (service, action, actor_user_id, actor_email, target_type, target_id, before, after, result)
    VALUES ('auth', 'admin.roles.update', 'system', 'migration', 'role', ids[i]::text,
            jsonb_build_object('name', olds[i]),
            jsonb_build_object('name', candidate, 'reason', 'same_group', 'same_group_as', keepers[i]), 'success');
  END LOOP;

  -- Grants of a renamed role: a temporary one goes back to the role it would restore when that is not renamed too,
  -- any other is removed.
  FOR g IN
    SELECT ucr.user_id, ucr.cluster_id, u.email, ucr.role_id, ucr.namespaces,
           ucr.restore_role_id, rr.name AS restore_role, ucr.restore_namespaces,
           ucr.restore_role_id IS NOT NULL AND NOT ucr.restore_role_id = ANY (ids) AS restores
      FROM user_cluster_roles ucr
      JOIN auth_users u ON u.id = ucr.user_id
      LEFT JOIN roles rr ON rr.id = ucr.restore_role_id
     WHERE ucr.role_id = ANY (ids)
     ORDER BY ucr.user_id, ucr.cluster_id
  LOOP
    i := array_position(ids, g.role_id);
    IF g.restores THEN
      UPDATE user_cluster_roles
         SET role_id = g.restore_role_id, namespaces = g.restore_namespaces, expires_at = NULL,
             restore_role_id = NULL, restore_namespaces = NULL, request_id = NULL
       WHERE user_id = g.user_id AND cluster_id = g.cluster_id;
    ELSE
      DELETE FROM user_cluster_roles WHERE user_id = g.user_id AND cluster_id = g.cluster_id;
    END IF;
    users := users || g.user_id::text;
    INSERT INTO auth_audit_logs (service, action, actor_user_id, actor_email, target_user_id, target_email, target_type, target_id, cluster, before, after, result)
    VALUES ('auth', 'user.cluster_role.unset', 'system', 'migration', g.user_id, g.email, 'user', g.user_id, g.cluster_id,
            jsonb_build_object('role', olds[i], 'namespaces', g.namespaces),
            jsonb_build_object('reason', 'role_renamed', 'renamed_to', news[i], 'restored_role', CASE WHEN g.restores THEN g.restore_role END),
            'success');
  END LOOP;

  -- A temporary grant of another role that would bring a renamed role back: it ends with nothing to restore.
  FOR g IN
    SELECT ucr.user_id, ucr.cluster_id, u.email, ucr.restore_role_id, ucr.restore_namespaces
      FROM user_cluster_roles ucr
      JOIN auth_users u ON u.id = ucr.user_id
     WHERE ucr.restore_role_id = ANY (ids)
     ORDER BY ucr.user_id, ucr.cluster_id
  LOOP
    i := array_position(ids, g.restore_role_id);
    UPDATE user_cluster_roles SET restore_role_id = NULL, restore_namespaces = NULL
     WHERE user_id = g.user_id AND cluster_id = g.cluster_id;
    users := users || g.user_id::text;
    INSERT INTO auth_audit_logs (service, action, actor_user_id, actor_email, target_user_id, target_email, target_type, target_id, cluster, before, after, result)
    VALUES ('auth', 'user.cluster_role.unset', 'system', 'migration', g.user_id, g.email, 'user', g.user_id, g.cluster_id,
            jsonb_build_object('restore_role', olds[i], 'restore_namespaces', g.restore_namespaces),
            jsonb_build_object('reason', 'role_renamed', 'renamed_to', news[i], 'restore_role', NULL::text),
            'success');
  END LOOP;

  -- Pending and approved access requests for a renamed role end; an approved one's grant went above.
  FOR g IN
    SELECT ar.id, ar.user_id, ar.cluster_id, ar.role_id, ar.status, u.email
      FROM access_requests ar
      JOIN auth_users u ON u.id = ar.user_id
     WHERE ar.role_id = ANY (ids) AND ar.status IN ('pending', 'approved')
     ORDER BY ar.id
  LOOP
    i := array_position(ids, g.role_id);
    UPDATE access_requests SET status = 'expired', ended_at = NOW(), end_reason = 'role_renamed' WHERE id = g.id;
    INSERT INTO auth_audit_logs (service, action, actor_user_id, actor_email, target_user_id, target_email, target_type, target_id, cluster, after, result)
    VALUES ('auth', 'access.request.expire', 'system', 'migration', g.user_id, g.email, 'user', g.user_id, g.cluster_id,
            jsonb_build_object('request_id', g.id, 'role', olds[i], 'status', g.status, 'end_reason', 'role_renamed', 'renamed_to', news[i]),
            'success');
  END LOOP;

  -- An account level of a renamed role of Pending's group waits for approval as before, on the built-in Pending.
  FOR g IN
    SELECT u.id, u.email, u.role_id
      FROM auth_users u
     WHERE u.role_id = ANY (ids) AND keepers[array_position(ids, u.role_id)] = 'Pending'
     ORDER BY u.id
  LOOP
    IF pending IS NULL THEN
      SELECT id INTO pending FROM roles WHERE name = 'Pending';
      IF pending IS NULL THEN
        INSERT INTO roles (name, description, is_system) VALUES ('Pending', '승인 대기', true) RETURNING id INTO pending;
      END IF;
    END IF;
    i := array_position(ids, g.role_id);
    UPDATE auth_users SET role_id = pending, updated_at = NOW() WHERE id = g.id;
    users := users || g.id::text;
    INSERT INTO auth_audit_logs (service, action, actor_user_id, actor_email, target_user_id, target_email, target_type, target_id, before, after, result)
    VALUES ('auth', 'user.role.update', 'system', 'migration', g.id, g.email, 'user', g.id,
            jsonb_build_object('role', olds[i]),
            jsonb_build_object('role', 'Pending', 'reason', 'role_renamed', 'renamed_to', news[i]), 'success');
  END LOOP;

  -- Tokens naming a removed grant or an old name: the next request signs in again.
  UPDATE auth_users SET token_version = token_version + 1, updated_at = NOW()
   WHERE id = ANY (users) OR role_id = ANY (ids);
END
$$;
-- +goose StatementEnd

CREATE UNIQUE INDEX IF NOT EXISTS roles_name_group_key ON roles (role_group_slug(name));

-- +goose Down
-- The renamed roles keep their new names and the removed grants stay removed: the audit rows say what they were.
DROP INDEX IF EXISTS roles_name_group_key;
DROP FUNCTION IF EXISTS role_group_slug(text);
