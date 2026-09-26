package config

import "fmt"

// Validate rejects settings the service would otherwise mishandle silently.
// Called once at startup; an error is fatal.
func (c Config) Validate() error {
	switch c.PasswordLogin {
	case "on", "admin-only", "off":
	default:
		return fmt.Errorf("PASSWORD_LOGIN must be on, admin-only or off (got %q)", c.PasswordLogin)
	}
	if !c.OIDC.Enabled {
		return nil
	}
	for _, f := range []struct{ name, value string }{
		{"OIDC_ISSUER_URL", c.OIDC.IssuerURL},
		{"OIDC_CLIENT_ID", c.OIDC.ClientID},
		{"OIDC_CLIENT_SECRET", c.OIDC.ClientSecret},
		{"OIDC_REDIRECT_URL", c.OIDC.RedirectURL},
	} {
		if f.value == "" {
			return fmt.Errorf("%s is required when OIDC_ENABLED=true", f.name)
		}
	}
	// Read and Write are per-cluster roles. As an account level they are
	// collapsed to Member at startup (repository schema migration), so a group
	// mapped to them would lose its effect on the next restart.
	for group, role := range c.OIDC.RoleMapping {
		if isClusterOnlyRole(role) {
			return fmt.Errorf("OIDC_ROLE_MAPPING %s=%s: Read/Write are per-cluster roles; map the group to Admin or Member and grant clusters with %s<cluster-id>:%s groups", group, role, c.OIDC.ClusterGroupPrefix, role)
		}
	}
	if isClusterOnlyRole(c.OIDC.DefaultRole) {
		return fmt.Errorf("OIDC_DEFAULT_ROLE %s: Read/Write are per-cluster roles; use Pending or Member", c.OIDC.DefaultRole)
	}
	return nil
}

func isClusterOnlyRole(name string) bool {
	return name == "Read" || name == "Write"
}
