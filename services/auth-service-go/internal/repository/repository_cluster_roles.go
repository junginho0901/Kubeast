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
