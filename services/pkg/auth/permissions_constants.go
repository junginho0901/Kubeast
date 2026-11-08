package auth

// Permission keys for cluster management. Added for the multi-cluster feature
// (00-COMMON §2-3). These are admin-only; the system "Admin" role's "*"
// wildcard already grants them, so no role seed change is required. Per-cluster
// resource access (resource.*/menu.*/ai.tool.*) is granted separately via
// user_cluster_roles, not by these keys.
const (
	PermClustersList   = "admin.clusters.list"
	PermClustersCreate = "admin.clusters.create"
	PermClustersDelete = "admin.clusters.delete"
	PermClustersUpdate = "admin.clusters.update"
)

// PermObjectsRead is what a list or detail with no permission of its own asks. It is not a kind: resource.*.read covers
// it and the routes that ask more (Pod logs, Helm, Cost), so a role can hold the lists without those.
const PermObjectsRead = "resource.objects.read"
