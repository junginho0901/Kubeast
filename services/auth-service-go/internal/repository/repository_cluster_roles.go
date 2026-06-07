package repository

import "context"

// UserClusterRole is one (cluster, role) grant for a user — a row of
// user_cluster_roles. No row for a (user, cluster) pair means no access to that
// cluster (deny-by-default).
type UserClusterRole struct {
	ClusterID string
	RoleID    int
}

// ListUserClusterRoles returns every per-cluster role grant for a user. Used
// when building the JWT permission matrix at login.
func (r *Repository) ListUserClusterRoles(ctx context.Context, userID string) ([]UserClusterRole, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT cluster_id, role_id FROM user_cluster_roles WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []UserClusterRole
	for rows.Next() {
		var ucr UserClusterRole
		if err := rows.Scan(&ucr.ClusterID, &ucr.RoleID); err != nil {
			return nil, err
		}
		out = append(out, ucr)
	}
	return out, rows.Err()
}

// ListUserClusterRoleNames returns the user's per-cluster grants as a
// clusterID → role-name map (for the GET cluster-roles API). No rows → empty map.
func (r *Repository) ListUserClusterRoleNames(ctx context.Context, userID string) (map[string]string, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT ucr.cluster_id, ro.name
		   FROM user_cluster_roles ucr JOIN roles ro ON ro.id = ucr.role_id
		  WHERE ucr.user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]string)
	for rows.Next() {
		var cid, role string
		if err := rows.Scan(&cid, &role); err != nil {
			return nil, err
		}
		out[cid] = role
	}
	return out, rows.Err()
}

// SetUserClusterRole grants (or re-grants) roleID to userID on clusterID.
// Upsert on the (user_id, cluster_id) pair so a re-grant updates the role.
func (r *Repository) SetUserClusterRole(ctx context.Context, userID, clusterID string, roleID int) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO user_cluster_roles (user_id, cluster_id, role_id)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, cluster_id) DO UPDATE SET role_id = EXCLUDED.role_id`,
		userID, clusterID, roleID)
	return err
}

// DeleteUserClusterRole revokes a user's access to clusterID. Returns whether a
// row existed (so the handler can 404 a no-op delete).
func (r *Repository) DeleteUserClusterRole(ctx context.Context, userID, clusterID string) (bool, error) {
	tag, err := r.pool.Exec(ctx,
		`DELETE FROM user_cluster_roles WHERE user_id = $1 AND cluster_id = $2`, userID, clusterID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// ListAccessibleClusterIDs returns the distinct cluster IDs a user has any grant
// on — used by ListClusters(accessibleOnly) for non-admin callers.
func (r *Repository) ListAccessibleClusterIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT DISTINCT cluster_id FROM user_cluster_roles WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var cid string
		if err := rows.Scan(&cid); err != nil {
			return nil, err
		}
		out = append(out, cid)
	}
	return out, rows.Err()
}

// GrantClusterRoleToUsersWithGlobalRole grants (cluster, grantRoleID) to every
// user whose global role is globalRoleID. Used by grantToAllAdmins on cluster
// registration. Existing grants are left untouched. Returns rows inserted.
func (r *Repository) GrantClusterRoleToUsersWithGlobalRole(ctx context.Context, clusterID string, grantRoleID, globalRoleID int) (int64, error) {
	tag, err := r.pool.Exec(ctx,
		`INSERT INTO user_cluster_roles (user_id, cluster_id, role_id)
		 SELECT id, $1, $2 FROM auth_users WHERE role_id = $3
		 ON CONFLICT (user_id, cluster_id) DO NOTHING`,
		clusterID, grantRoleID, globalRoleID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
