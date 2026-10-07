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
	if c.APIKeys.Enabled && c.APIKeys.MaxDays < 1 {
		return fmt.Errorf("API_KEYS_MAX_DAYS must be at least 1 (got %d)", c.APIKeys.MaxDays)
	}
	if c.AccessReview.Enabled && (c.AccessReview.DormantDays < 1 || c.AccessReview.IntervalDays < 1) {
		return fmt.Errorf("ACCESS_REVIEW_DORMANT_DAYS and ACCESS_REVIEW_INTERVAL_DAYS must be at least 1 (got %d, %d)", c.AccessReview.DormantDays, c.AccessReview.IntervalDays)
	}
	if c.DormantAccounts.Enabled && (c.DormantAccounts.Days < 1 || c.DormantAccounts.SweepHours < 1) {
		return fmt.Errorf("DORMANT_ACCOUNTS_DAYS and DORMANT_ACCOUNTS_SWEEP_HOURS must be at least 1 (got %d, %d)", c.DormantAccounts.Days, c.DormantAccounts.SweepHours)
	}
	if c.RetentionReviewDays < 0 {
		return fmt.Errorf("RETENTION_REVIEW_DAYS must be 0 or positive (got %d)", c.RetentionReviewDays)
	}
	if c.AccessRequests.Enabled {
		if c.AccessRequests.MaxHours < 1 {
			return fmt.Errorf("ACCESS_REQUESTS_MAX_HOURS must be at least 1 (got %d)", c.AccessRequests.MaxHours)
		}
		if len(c.AccessRequests.Roles) == 0 {
			return fmt.Errorf("ACCESS_REQUESTS_ROLES must name at least one role when ACCESS_REQUESTS_ENABLED=true")
		}
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
