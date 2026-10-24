package auth

import (
	"encoding/base64"
	"encoding/json"
	"strings"
)

// HeaderAccess carries a response's Access, base64url JSON (a role name may
// not be ASCII).
const HeaderAccess = "X-Kubeast-Access"

// Access is the identity a request reached a cluster as, shown next to an AI
// tool call and kept in its audit row. It is computed by the service that
// sends the cluster request, from the same Impersonation, so what is shown is
// what was sent.
type Access struct {
	Cluster string `json:"cluster"`
	// Kind is "person", "api_key", "investigator" or "system".
	Kind   string `json:"kind"`
	APIKey string `json:"api_key,omitempty"`
	// User and Groups are the Impersonate-User / Impersonate-Group values;
	// empty when impersonation is off and the service credential acts itself.
	User   string   `json:"user,omitempty"`
	Groups []string `json:"groups,omitempty"`
	// Role is the Kubeast role in the cluster, "*" for the global admin entry.
	Role string `json:"role,omitempty"`
	// Namespaces limit the grant there; empty = the whole cluster.
	Namespaces    []string `json:"namespaces,omitempty"`
	Impersonation bool     `json:"impersonation"`
}

// Access returns the identity calls to clusterID go out as.
func (p TokenPayload) Access(clusterID string, impersonation bool) Access {
	a := Access{Cluster: clusterID, Kind: "person", Impersonation: impersonation}
	switch {
	case p.System == SystemInvestigator:
		a.Kind = "investigator"
	case p.System != "":
		a.Kind = "system"
	case p.APIKeyID != "":
		a.Kind, a.APIKey = "api_key", p.APIKeyID
	}
	if p.System == "" {
		a.Role = strings.TrimSpace(p.Roles[clusterID])
		if a.Role == "" && matchAny(p.Perms["*"], "*") {
			a.Role = "*"
		}
		a.Namespaces = p.Namespaces[clusterID]
	}
	if impersonation {
		a.User, a.Groups = p.Impersonation(clusterID)
	}
	return a
}

// Header renders a for HeaderAccess.
func (a Access) Header() string {
	b, _ := json.Marshal(a)
	return base64.RawURLEncoding.EncodeToString(b)
}
