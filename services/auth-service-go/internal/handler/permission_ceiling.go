package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Permission ceiling. Nobody may hand out more than they hold — the same
// rule Kubernetes RBAC applies to creating roles and bindings: a caller may
// only grant permissions they already have. It covers role create/update,
// global role assignment (single, bulk, at user creation) and per-cluster
// grants. Permission strings must also come from the catalog the UI offers.
// An account that exists has its own ceilings: becoming it (accountCeiling) and
// managing it (globalCeiling).

// errCeiling marks a refused grant so the audit row records the attempt.
var errCeiling = errors.New("permission ceiling")

var (
	catalogOnce sync.Once
	catalogKeys map[string]struct{}
)

// catalog is the set of permission keys allPermissions() publishes,
// wildcard entries included (read through its JSON shape, the one the UI
// consumes).
func catalog() map[string]struct{} {
	catalogOnce.Do(func() {
		catalogKeys = make(map[string]struct{})
		var categories []struct {
			Permissions []struct {
				Key string `json:"key"`
			} `json:"permissions"`
		}
		raw, _ := json.Marshal(allPermissions())
		_ = json.Unmarshal(raw, &categories)
		for _, c := range categories {
			for _, p := range c.Permissions {
				catalogKeys[p.Key] = struct{}{}
			}
		}
	})
	return catalogKeys
}

// unknownPermissions lists the requested keys that are not in the catalog.
func unknownPermissions(perms []string) []string {
	var unknown []string
	for _, p := range perms {
		if _, ok := catalog()[p]; !ok {
			unknown = append(unknown, p)
		}
	}
	sort.Strings(unknown)
	return unknown
}

// missingPermissions lists the requested permissions the actor does not hold.
// For a per-cluster grant (clusterID set) a permission counts when held
// globally or on that cluster. For a global object (clusterID "": authoring a
// role, assigning a global role) it counts when held globally, and a
// cluster-scoped one also when held on any cluster — the token's "*" entry
// carries only "*" and admin.* (buildPermissionMatrix), so cluster-scoped
// permissions can only ever be held per cluster, and the grant that makes such
// a role effective is ceiling-checked per cluster again. A global permission
// counts from the "*" entry only: "*" granted on one cluster is that cluster's
// (as Kubernetes RBAC wants a ClusterRole's permissions granted cluster-wide).
// Wildcard containment follows permMatches: holding resource.pod.read does not
// cover resource.*.read, holding "*" covers everything.
func missingPermissions(actor auth.TokenPayload, perms []string, clusterID string) []string {
	var missing []string
	for _, p := range perms {
		held := actor.HasPermission(p)
		if !held && clusterID != "" {
			held = actor.HasPermissionForCluster(p, clusterID)
		}
		if !held && clusterID == "" && !isGlobalPermission(p) {
			for c := range actor.Perms {
				if c != "*" && actor.HasPermissionForCluster(p, c) {
					held = true
					break
				}
			}
		}
		if !held {
			missing = append(missing, p)
		}
	}
	sort.Strings(missing)
	return missing
}

// ceilingError describes a refused grant for the response and the audit row
// (one line: the UI shows it as is).
func ceilingError(missing []string) error {
	return fmt.Errorf("%w: cannot grant permissions you do not hold: %s", errCeiling, strings.Join(missing, ", "))
}

// maxGrantNamespaces caps a namespace-scoped grant: the list travels in every
// token of that user and every all-namespaces read fans out over it.
const maxGrantNamespaces = 50

// normalizeNamespaces validates a grant's namespace list: trimmed, lowercase
// DNS labels (what Kubernetes accepts as a namespace name), no duplicates, at
// most maxGrantNamespaces, sorted. Empty in → nil (the whole cluster).
func normalizeNamespaces(in []string) ([]string, error) {
	seen := map[string]struct{}{}
	var out []string
	for _, raw := range in {
		n := strings.TrimSpace(raw)
		if n == "" {
			continue
		}
		if !validNamespaceName(n) {
			return nil, fmt.Errorf("invalid namespace %q: lowercase letters, digits and '-' only, 1-63 characters", n)
		}
		if _, dup := seen[n]; dup {
			continue
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}
	if len(out) > maxGrantNamespaces {
		return nil, fmt.Errorf("at most %d namespaces per grant (grant the whole cluster instead)", maxGrantNamespaces)
	}
	sort.Strings(out)
	return out, nil
}

func validNamespaceName(n string) bool {
	if len(n) == 0 || len(n) > 63 {
		return false
	}
	for i := 0; i < len(n); i++ {
		c := n[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '-' && i > 0 && i < len(n)-1:
		default:
			return false
		}
	}
	return true
}

// missingNamespaces applies the ceiling to scope: a grantor whose own grant
// on clusterID is limited to namespaces may hand out only those, and never the
// whole cluster. An unscoped grantor (or a global admin) is not limited.
// Returns the namespaces the grantor lacks; "*" stands for the whole cluster.
func missingNamespaces(actor auth.TokenPayload, clusterID string, namespaces []string) []string {
	own := actor.Namespaces[clusterID]
	if len(own) == 0 || auth.MatchAny(actor.Perms["*"], "*") {
		return nil
	}
	if len(namespaces) == 0 {
		return []string{"*"}
	}
	var missing []string
	for _, n := range namespaces {
		if !actor.AllowedIn(clusterID, n) {
			missing = append(missing, n)
		}
	}
	return missing
}

func ceilingNamespacesError(missing []string) error {
	if len(missing) == 1 && missing[0] == "*" {
		return fmt.Errorf("%w: your grant on this cluster is limited to namespaces; you cannot grant the whole cluster", errCeiling)
	}
	return fmt.Errorf("%w: cannot grant namespaces you do not hold: %s", errCeiling, strings.Join(missing, ", "))
}

// missingOnCluster lists, each with its cluster, the permissions and the scope
// of a grant on clusterID that the actor does not hold there.
func missingOnCluster(actor auth.TokenPayload, perms []string, clusterID string, namespaces []string) []string {
	var missing []string
	for _, p := range missingPermissions(actor, perms, clusterID) {
		missing = append(missing, clusterID+": "+p)
	}
	for _, n := range missingNamespaces(actor, clusterID, namespaces) {
		if n == "*" {
			missing = append(missing, clusterID+": the whole cluster")
			continue
		}
		missing = append(missing, clusterID+": namespace "+n)
	}
	return missing
}

func ceilingAccountError(email string, missing []string) error {
	sort.Strings(missing)
	return fmt.Errorf("%w: %s holds what you do not: %s", errCeiling, email, strings.Join(missing, ", "))
}

// accountCeiling is the ceiling on becoming an account: a new password hands it
// over, so the actor must hold all it holds. That is what its token would carry,
// so the cluster keys of a global role, which give nothing
// (buildPermissionMatrix), do not count. One's own account is within reach. A
// refusal wraps errCeiling.
func (h *AuthHandler) accountCeiling(ctx context.Context, actor auth.TokenPayload, target *model.User) error {
	if target.ID == actor.UserID || auth.MatchAny(actor.Perms["*"], "*") {
		return nil
	}
	rolePerms, err := h.repo.GetPermissionsByRoleID(ctx, target.RoleID)
	if err != nil {
		return err
	}
	matrix, err := h.buildPermissionMatrix(ctx, target.ID, rolePerms)
	if err != nil {
		return err
	}
	namespaces, err := h.repo.ListUserClusterNamespaces(ctx, target.ID)
	if err != nil {
		return err
	}
	var missing []string
	for clusterID, perms := range matrix {
		if clusterID == "*" {
			missing = append(missing, missingPermissions(actor, perms, "")...)
			continue
		}
		missing = append(missing, missingOnCluster(actor, perms, clusterID, namespaces[clusterID])...)
	}
	if len(missing) > 0 {
		return ceilingAccountError(target.Email, missing)
	}
	return nil
}

// globalCeiling is the ceiling on managing an account: deleting it, changing its
// role or grants or lifting a lock gains the actor nothing, and taking access
// away must not wait for someone who holds it, so only the global permissions the
// actor lacks keep them out. What they hand out stays under the ceiling of each
// grant. One's own account is within reach. A refusal wraps errCeiling.
func (h *AuthHandler) globalCeiling(ctx context.Context, actor auth.TokenPayload, target *model.User) error {
	if target.ID == actor.UserID || auth.MatchAny(actor.Perms["*"], "*") {
		return nil
	}
	rolePerms, err := h.repo.GetPermissionsByRoleID(ctx, target.RoleID)
	if err != nil {
		return err
	}
	if missing := missingPermissions(actor, globalPermissions(rolePerms), ""); len(missing) > 0 {
		return ceilingAccountError(target.Email, missing)
	}
	return nil
}

// refuseCeiling answers what a ceiling check returned: 403 with ev as a failure
// row for a refusal, 500 for an account it could not read. It says whether it
// answered.
func (h *AuthHandler) refuseCeiling(w http.ResponseWriter, r *http.Request, actor auth.TokenPayload, target *model.User, err error, ev auditEvent) bool {
	if err == nil {
		return false
	}
	if !errors.Is(err, errCeiling) {
		response.InternalError(w, r, err)
		return true
	}
	ev.targetType, ev.targetID, ev.targetEmail, ev.err = "user", target.ID, target.Email, err
	writeAudit(h.auditStore, r, actor, ev)
	response.Error(w, http.StatusForbidden, err.Error())
	return true
}
