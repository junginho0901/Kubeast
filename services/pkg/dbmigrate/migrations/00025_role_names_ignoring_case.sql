-- +goose Up
-- A role acts on a cluster as a group made from its name in lower case (auth.RoleGroupSlug), so two names that differ
-- only in letter case are one group, and a custom role named as a built-in in other capitals acts as that built-in.
-- auth-service refuses such a name when a role is made or renamed; this index refuses it in the database too, so two
-- saves at the same moment cannot both pass the handler's check.
-- Names stored before the rule stay as they are: of the rows whose names are equal ignoring case and surrounding
-- spaces, the built-in (else the oldest) keeps its place in the index and the others are marked name_kept and left out
-- of it. auth-service clears the mark when such a role is renamed (repository.UpdateRole), and the seed marks a custom
-- role that a new built-in's name would collide with (SeedSystemRoles), so neither an upgrade nor a boot fails on
-- names already there.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS name_kept BOOLEAN NOT NULL DEFAULT false;

UPDATE roles r SET name_kept = true
FROM (
  SELECT id, row_number() OVER (PARTITION BY lower(btrim(name)) ORDER BY is_system DESC, id) AS place
  FROM roles
) ranked
WHERE r.id = ranked.id AND ranked.place > 1;

CREATE UNIQUE INDEX IF NOT EXISTS roles_name_folded_key ON roles (lower(btrim(name))) WHERE NOT name_kept;

-- +goose Down
DROP INDEX IF EXISTS roles_name_folded_key;
ALTER TABLE roles DROP COLUMN IF EXISTS name_kept;
