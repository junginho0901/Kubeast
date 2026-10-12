package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// Permission ceiling. Nobody may hand out more than they hold — the same
// rule Kubernetes RBAC applies to creating roles and bindings: a caller may
// only grant permissions they already have. It covers role create/update,
// global role assignment (single, bulk, at user creation) and per-cluster
// grants. Permission strings must also come from the catalog the UI offers.

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
// role, assigning a global role) it counts when held globally or on any
// cluster — the token's "*" entry carries only admin.* (buildPermissionMatrix),
// so cluster-scoped permissions can only ever be held per cluster, and the
// grant that makes such a role effective is ceiling-checked per cluster
// again. Wildcard containment follows permMatches: holding resource.pod.read
// does not cover resource.*.read, holding "*" covers everything.
func missingPermissions(actor auth.TokenPayload, perms []string, clusterID string) []string {
	var missing []string
	for _, p := range perms {
		held := actor.HasPermission(p)
		if !held && clusterID != "" {
			held = actor.HasPermissionForCluster(p, clusterID)
		}
		if !held && clusterID == "" {
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
	if len(own) == 0 {
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
