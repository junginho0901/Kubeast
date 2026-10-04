package handler

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The parts of an access request that need no database: the request body
// against the configured policy, the Write ceiling, and who may decide.

// accessRequestInput is the body of POST /access-requests.
type accessRequestInput struct {
	ClusterID       string `json:"cluster_id"`
	Role            string `json:"role"`
	DurationMinutes int    `json:"duration_minutes"`
	Reason          string `json:"reason"`
}

// accessRequestCeilingRole is the system role no requestable role may exceed.
const accessRequestCeilingRole = "Write"

const accessRequestReasonMax = 500

var errOwnAccessRequest = errors.New("you cannot decide your own access request")

// validateAccessRequestInput checks the user-supplied fields against the
// policy: a cluster and a requestable role, a duration of 1 minute up to
// MaxHours, and a reason (every reference requires one for elevated access).
func validateAccessRequestInput(in accessRequestInput, cfg config.AccessRequestsConfig) error {
	if strings.TrimSpace(in.ClusterID) == "" {
		return errors.New("cluster_id required")
	}
	if strings.TrimSpace(in.Role) == "" {
		return errors.New("role required")
	}
	if !roleRequestable(in.Role, cfg.Roles) {
		return fmt.Errorf("role %q cannot be requested (allowed: %s)", in.Role, strings.Join(cfg.Roles, ", "))
	}
	maxMinutes := cfg.MaxHours * 60
	if in.DurationMinutes < 1 || in.DurationMinutes > maxMinutes {
		return fmt.Errorf("duration_minutes must be between 1 and %d", maxMinutes)
	}
	reason := strings.TrimSpace(in.Reason)
	if reason == "" {
		return errors.New("reason required")
	}
	if len(reason) > accessRequestReasonMax {
		return fmt.Errorf("reason must be at most %d characters", accessRequestReasonMax)
	}
	return nil
}

func roleRequestable(role string, allowed []string) bool {
	for _, a := range allowed {
		if strings.EqualFold(strings.TrimSpace(a), role) {
			return true
		}
	}
	return false
}

// uncoveredPermissions returns the permissions in rolePerms that the ceiling
// does not grant, sorted; nil means the role stays within the ceiling. The
// ceiling is matched with the same wildcard rules the validators use, so
// "resource.*.read" covers "resource.pod.read". An empty role is never within
// (account-level roles such as Member carry no permissions and are not
// something to escalate to).
func uncoveredPermissions(rolePerms, ceiling []string) []string {
	if len(rolePerms) == 0 {
		return []string{"(no permissions)"}
	}
	m := auth.PermissionMatrix{"*": ceiling}
	var out []string
	for _, p := range rolePerms {
		if !m.HasForCluster(p, "*") {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// canDecideAccessRequest refuses a decision on one's own request. The caller
// has already checked the decider holds admin.users.update; the ceiling (the
// decider must hold what the role grants on that cluster) is checked with
// missingPermissions like a direct grant.
func canDecideAccessRequest(decider auth.TokenPayload, req *repository.AccessRequest) error {
	if decider.UserID == req.UserID {
		return errOwnAccessRequest
	}
	return nil
}
