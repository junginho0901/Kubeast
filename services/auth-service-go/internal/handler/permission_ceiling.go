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
