package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"
)

// Kubernetes impersonation (Authenticating → User impersonation): every call a
// Kubeast service makes to a cluster on behalf of a signed-in user carries
// Impersonate-User / Impersonate-Group headers, so the API server authorizes
// and audits the person, not Kubeast's own credential. The credential only
// needs the "impersonate" verb on users and groups.
// A read check k8s-service shares by group goes out as GroupCheckUserPrefix plus a part made at start (AsGroupCheck).
//
// Group names are stable and bound per cluster (templates/impersonation-rbac):
//
//	kubeast:authenticated  every signed-in user (no rights by itself)
//	kubeast:viewer         Read role in that cluster        → view + cluster-scoped read
//	kubeast:operator       Write role in that cluster       → edit + viewer
//	kubeast:admin          Admin role there, or global "*"  → cluster-admin
//	kubeast:role:<name>    any other (custom) role — no rights until the cluster binds it;
//	                       also a Read/Write/Admin grant limited to namespaces ("ns"
//	                       claim), since viewer/operator/admin are bound cluster-wide
//
// A built-in role is known by its exact name (IsBuiltinRole). A custom role
// whose name makes a built-in's slug ("ADMIN", "write") gets no role group.
const (
	GroupAuthenticated = "kubeast:authenticated"
	GroupViewer        = "kubeast:viewer"
	GroupOperator      = "kubeast:operator"
	GroupAdmin         = "kubeast:admin"
	groupRolePrefix    = "kubeast:role:"

	HeaderImpersonateUser  = "Impersonate-User"
	HeaderImpersonateGroup = "Impersonate-Group"

	// The alert investigator (features.alertInvestigation) is not a person:
	// auth-service issues it a short token with "sys": "investigator" and it
	// acts in a cluster as this user and group only, which
	// templates/impersonation-investigator.yaml binds read-only.
	SystemInvestigator = "investigator"
	UserInvestigator   = "kubeast:investigator"
	GroupInvestigator  = "kubeast:investigator"

	// GroupCheckUserPrefix starts the user name of a read check whose allow everyone with the same groups is given
	// (k8s-service, auth.impersonation.sharedReadChecks); k8s-service adds a part made at each start.
	GroupCheckUserPrefix = "kubeast:group-check:"

	// userPrefixEnv is chart auth.impersonation.userPrefix: a name of Kubeast's own before a person's address, so a
	// binding a cluster made of that address for its own sign-in is not opened by a Kubeast account holding it. Off by
	// default, as a binding of a User to an address stops applying when it is on; groups do not change.
	userPrefixEnv = "IMPERSONATION_USER_PREFIX"
)

// Impersonation returns the Kubernetes identity to act as in clusterID.
func (p TokenPayload) Impersonation(clusterID string) (user string, groups []string) {
	user = strings.TrimSpace(p.Email)
	if user == "" {
		user = p.UserID
	}
	if p.System != "" {
		if p.System == SystemInvestigator {
			return UserInvestigator, []string{GroupInvestigator}
		}
		return user, []string{GroupAuthenticated}
	}
	user = strings.TrimSpace(os.Getenv(userPrefixEnv)) + user
	set := map[string]struct{}{GroupAuthenticated: {}}
	if matchAny(p.Perms["*"], "*") {
		set[GroupAdmin] = struct{}{}
	}
	if role := p.Roles[clusterID]; strings.TrimSpace(role) != "" && !TakesBuiltinSlug(role) {
		switch {
		case len(p.Namespaces[clusterID]) > 0:
			set[groupRolePrefix+RoleGroupSlug(role)] = struct{}{}
		case role == "Admin":
			set[GroupAdmin] = struct{}{}
		case role == "Write":
			set[GroupOperator] = struct{}{}
		case role == "Read":
			set[GroupViewer] = struct{}{}
		default:
			set[groupRolePrefix+RoleGroupSlug(role)] = struct{}{}
		}
	}
	for g := range set {
		groups = append(groups, g)
	}
	sort.Strings(groups)
	return user, groups
}

// CacheIdentity is a short hash of the identity Impersonation returns for
// clusterID, for keying a cached cluster answer: the cluster decides what each
// identity may see, so one user's answer is never served to another. The hash
// keeps user data out of the key.
func (p TokenPayload) CacheIdentity(clusterID string) string {
	user, groups := p.Impersonation(clusterID)
	sum := sha256.Sum256([]byte(user + "|" + strings.Join(groups, ",")))
	return hex.EncodeToString(sum[:8])
}

// ClaimsKey is a short hash of all a token says about who holds it and what they may do, its times aside: the checks
// Kubeast makes and the cluster's answer are the same for two requests with one key, so they may share one read of the
// cluster. "" when it cannot be worked out, which shares nothing.
func (p TokenPayload) ClaimsKey() string {
	p.AuthTime, p.ExpiresAt = 0, 0
	b, err := json.Marshal(p)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:16])
}

// builtinRoleSlugs are the built-in roles' names, exactly as auth-service's
// SeedSystemRoles writes them (every release has seeded these spellings), and
// their slugs. A token carries a grant's role name only; names are unique, so
// the exact name tells a built-in apart from a custom role.
var builtinRoleSlugs = map[string]string{"Pending": "pending", "Member": "member", "Read": "read", "Write": "write", "Admin": "admin"}

// IsBuiltinRole reports whether name is a built-in role's name as seeded.
func IsBuiltinRole(name string) bool {
	_, ok := builtinRoleSlugs[name]
	return ok
}

// BuiltinRoleNamed gives the built-in role whose name equals name ignoring case
// and surrounding spaces, for a setting written by hand ("admin" in a chart
// value stands for Admin). A role a token or a request names is read with
// IsBuiltinRole, never with this.
func BuiltinRoleNamed(name string) (string, bool) {
	name = strings.TrimSpace(name)
	for b := range builtinRoleSlugs {
		if strings.EqualFold(b, name) {
			return b, true
		}
	}
	return "", false
}

// TakesBuiltinSlug reports whether name is not a built-in role's but makes a
// built-in's slug ("ADMIN", " read ", "PENDING"): such a role acts on a cluster
// as no role group, neither the built-in's nor kubeast:role:<slug>, so it is
// never taken for the built-in. Migration 25 renamed the roles stored so and
// the database refuses new ones, so this is a second check.
func TakesBuiltinSlug(name string) bool {
	if IsBuiltinRole(name) {
		return false
	}
	slug := RoleGroupSlug(name)
	for _, s := range builtinRoleSlugs {
		if s == slug {
			return true
		}
	}
	return false
}

// RoleGroupSlug is the form of a role name its group is built from, trimmed as
// Impersonation trims it: two names with one slug act as one group. The
// database's role_group_slug, the frontend's roleGroupSlug and the chart's
// kubeast.roleSlug make the same (roleGroupSlug.cases.json).
func RoleGroupSlug(name string) string {
	return groupSlug(strings.TrimSpace(name))
}

// groupSlug makes a role name safe for a group, in ASCII: A-Z and the two letters Go lowers to ASCII (U+0130, U+212A)
// lowered, a-z 0-9 . _ - kept, any other ASCII character "-", and any other character "~" and its code point in four
// hex digits ("~~" and six above U+FFFF). No ASCII name makes a "~", so two names with other characters make one slug
// only when they differ in letter case, spaces or punctuation.
func groupSlug(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + 'a' - 'A')
		case r == '\u0130':
			b.WriteByte('i')
		case r == '\u212a':
			b.WriteByte('k')
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		case r < utf8.RuneSelf:
			b.WriteByte('-')
		case r <= 0xffff:
			fmt.Fprintf(&b, "~%04x", r)
		default:
			fmt.Fprintf(&b, "~~%06x", r)
		}
	}
	return b.String()
}

// WithPayload stores a validated payload in ctx — for work that outlives the
// HTTP request (a drain goroutine) but must still act as the user.
func WithPayload(ctx context.Context, p TokenPayload) context.Context {
	return context.WithValue(ctx, tokenPayloadKey, p)
}

// groupCheck is the user name and the groups a request of ctx goes out as instead of its person's name (AsGroupCheck).
type groupCheck struct {
	user   string
	groups []string
}

type groupCheckKey struct{}

// AsGroupCheck makes ctx's requests go out as user with groups, which must be the groups the person in ctx has on the
// cluster: a request whose person is missing or has other groups is not sent.
func AsGroupCheck(ctx context.Context, user string, groups []string) context.Context {
	return context.WithValue(ctx, groupCheckKey{}, groupCheck{user: user, groups: groups})
}

var errGroupCheck = errors.New("a check asked by groups names no person of those groups")

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
	check, byGroups := req.Context().Value(groupCheckKey{}).(groupCheck)
	if !ok && !byGroups {
		return t.base.RoundTrip(req)
	}
	var user string
	var groups []string
	if ok {
		user, groups = p.Impersonation(t.clusterID)
	}
	if byGroups {
		if !ok || check.user == "" || check.user == user || len(groups) == 0 || !slices.Equal(check.groups, groups) {
			if req.Body != nil {
				_ = req.Body.Close()
			}
			return nil, errGroupCheck
		}
		user = check.user
	}
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
