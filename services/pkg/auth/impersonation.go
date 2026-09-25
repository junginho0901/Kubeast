package auth

import (
	"context"
	"net/http"
	"sort"
	"strings"
)

// Kubernetes impersonation (Authenticating → User impersonation): every call a
// Kubeast service makes to a cluster on behalf of a signed-in user carries
// Impersonate-User / Impersonate-Group headers, so the API server authorizes
// and audits the person, not Kubeast's own credential. The credential only
// needs the "impersonate" verb on users and groups.
//
// Group names are stable and bound per cluster (templates/impersonation-rbac):
//
//	kubeast:authenticated  every signed-in user (no rights by itself)
//	kubeast:viewer         Read role in that cluster        → view + cluster-scoped read
//	kubeast:operator       Write role in that cluster       → edit + viewer
//	kubeast:admin          Admin role there, or global "*"  → cluster-admin
//	kubeast:role:<name>    any other (custom) role — no rights until the cluster binds it
const (
	GroupAuthenticated = "kubeast:authenticated"
	GroupViewer        = "kubeast:viewer"
	GroupOperator      = "kubeast:operator"
	GroupAdmin         = "kubeast:admin"
	groupRolePrefix    = "kubeast:role:"

	HeaderImpersonateUser  = "Impersonate-User"
	HeaderImpersonateGroup = "Impersonate-Group"
)

// Impersonation returns the Kubernetes identity to act as in clusterID.
func (p TokenPayload) Impersonation(clusterID string) (user string, groups []string) {
	user = strings.TrimSpace(p.Email)
	if user == "" {
		user = p.UserID
	}
	set := map[string]struct{}{GroupAuthenticated: {}}
	if matchAny(p.Perms["*"], "*") {
		set[GroupAdmin] = struct{}{}
	}
	if role := strings.TrimSpace(p.Roles[clusterID]); role != "" {
		switch strings.ToLower(role) {
		case "admin":
			set[GroupAdmin] = struct{}{}
		case "write":
			set[GroupOperator] = struct{}{}
		case "read":
			set[GroupViewer] = struct{}{}
		default:
			set[groupRolePrefix+groupSlug(role)] = struct{}{}
		}
	}
	for g := range set {
		groups = append(groups, g)
	}
	sort.Strings(groups)
	return user, groups
}

// groupSlug makes a role name safe for a group: lowercase, [a-z0-9._-] only.
func groupSlug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	return b.String()
}

// WithPayload stores a validated payload in ctx — for work that outlives the
// HTTP request (a drain goroutine) but must still act as the user.
func WithPayload(ctx context.Context, p TokenPayload) context.Context {
	return context.WithValue(ctx, tokenPayloadKey, p)
}

// impersonatingRoundTripper adds impersonation headers for the user found in
// the request context. Requests without a user (startup probes, health checks)
// go out under the service credential unchanged.
type impersonatingRoundTripper struct {
	base      http.RoundTripper
	clusterID string
}

// ImpersonationRoundTripper wraps base for one cluster; use it as
// rest.Config.Wrap(func(rt) { return ImpersonationRoundTripper(rt, id) }).
func ImpersonationRoundTripper(base http.RoundTripper, clusterID string) http.RoundTripper {
	return &impersonatingRoundTripper{base: base, clusterID: clusterID}
}

func (t *impersonatingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	p, ok := FromContext(req.Context())
	if !ok {
		return t.base.RoundTrip(req)
	}
	user, groups := p.Impersonation(t.clusterID)
	r2 := req.Clone(req.Context())
	r2.Header.Set(HeaderImpersonateUser, user)
	r2.Header.Del(HeaderImpersonateGroup)
	for _, g := range groups {
		r2.Header.Add(HeaderImpersonateGroup, g)
	}
	return t.base.RoundTrip(r2)
}

// KubectlImpersonationArgs renders the same identity as kubectl flags.
func KubectlImpersonationArgs(p TokenPayload, clusterID string) []string {
	user, groups := p.Impersonation(clusterID)
	args := []string{"--as", user}
	for _, g := range groups {
		args = append(args, "--as-group", g)
	}
	return args
}
