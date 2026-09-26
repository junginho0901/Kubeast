package config

import (
	"strings"
	"testing"
)

func oidcOK() Config {
	return Config{
		PasswordLogin: "admin-only",
		OIDC: OIDCConfig{
			Enabled: true, IssuerURL: "https://idp.example", ClientID: "c", ClientSecret: "s",
			RedirectURL: "https://app.example/api/v1/auth/oidc/callback",
			RoleMapping: map[string]string{"kubeast-admins": "Admin", "engineering": "Member", "dba": "DBA"},
			DefaultRole: "Pending", ClusterGroupPrefix: "kubeast:cluster:",
		},
	}
}

func TestValidate(t *testing.T) {
	if err := oidcOK().Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	off := Config{PasswordLogin: "on"}
	if err := off.Validate(); err != nil {
		t.Fatalf("OIDC off needs nothing else: %v", err)
	}

	bad := oidcOK()
	bad.PasswordLogin = "yes"
	if err := bad.Validate(); err == nil || !strings.Contains(err.Error(), "PASSWORD_LOGIN") {
		t.Fatalf("PASSWORD_LOGIN value must be checked: %v", err)
	}

	bad = oidcOK()
	bad.OIDC.ClientSecret = ""
	if err := bad.Validate(); err == nil || !strings.Contains(err.Error(), "OIDC_CLIENT_SECRET") {
		t.Fatalf("missing secret must be reported: %v", err)
	}

	bad = oidcOK()
	bad.OIDC.RoleMapping["sre"] = "Write"
	if err := bad.Validate(); err == nil || !strings.Contains(err.Error(), "kubeast:cluster:<cluster-id>:Write") {
		t.Fatalf("global Write mapping must be rejected with the cluster-group hint: %v", err)
	}

	bad = oidcOK()
	bad.OIDC.DefaultRole = "Read"
	if err := bad.Validate(); err == nil || !strings.Contains(err.Error(), "OIDC_DEFAULT_ROLE") {
		t.Fatalf("global Read default must be rejected: %v", err)
	}
}
