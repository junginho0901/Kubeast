package handler

import (
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

func TestValidateLogSearchFields(t *testing.T) {
	for _, ok := range []string{"http://loki.logging.svc:3100", "https://loki.example.com/", " https://logs.example.com/loki "} {
		if err := validateLogSearchURL(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "loki:3100", "ftp://x/y", "http://user:pw@loki:3100", "http://loki:3100/?x=1", "http://loki:3100/#f"} {
		if err := validateLogSearchURL(bad); err == nil || !strings.Contains(err.Error(), "log_search_url") {
			t.Errorf("%q: %v", bad, err)
		}
	}

	for _, ok := range []string{"team-a", "prod_1", "a.b", "x!y*('z')", strings.Repeat("t", 150)} {
		if err := validateLogSearchTenant(ok); err != nil {
			t.Errorf("tenant %q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", ".", "..", "a b", "a/b", "a|b", strings.Repeat("t", 151)} {
		if err := validateLogSearchTenant(bad); err == nil || !strings.Contains(err.Error(), "log_search_tenant") {
			t.Errorf("tenant %q: %v", bad, err)
		}
	}

	if h, err := logSearchAuthHeader(model.AuthHeaderRequest{Type: "bearer", Token: " tok "}); err != nil || h != "Bearer tok" {
		t.Fatalf("bearer = %q %v", h, err)
	}
	if h, err := logSearchAuthHeader(model.AuthHeaderRequest{Type: "none"}); err != nil || h != "" {
		t.Fatalf("none = %q %v", h, err)
	}
	if _, err := logSearchAuthHeader(model.AuthHeaderRequest{Type: "basic", Username: "u"}); err == nil || !strings.Contains(err.Error(), "log_search_auth") {
		t.Fatalf("basic without a password: %v", err)
	}
}
