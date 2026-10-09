package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

var testAccessCfg = config.AccessRequestsConfig{Enabled: true, MaxHours: 8, Roles: []string{"Write"}}

func TestValidateAccessRequestInput(t *testing.T) {
	ok := accessRequestInput{ClusterID: "alpha", Role: "Write", DurationMinutes: 120, Reason: "deploy hotfix"}
	if err := validateAccessRequestInput(ok, testAccessCfg); err != nil {
		t.Fatalf("valid input refused: %v", err)
	}
	cases := map[string]accessRequestInput{
		"no cluster":      {Role: "Write", DurationMinutes: 60, Reason: "x"},
		"no role":         {ClusterID: "alpha", DurationMinutes: 60, Reason: "x"},
		"admin role":      {ClusterID: "alpha", Role: "Admin", DurationMinutes: 60, Reason: "x"},
		"zero minutes":    {ClusterID: "alpha", Role: "Write", DurationMinutes: 0, Reason: "x"},
		"over max":        {ClusterID: "alpha", Role: "Write", DurationMinutes: 8*60 + 1, Reason: "x"},
		"no reason":       {ClusterID: "alpha", Role: "Write", DurationMinutes: 60, Reason: "   "},
		"reason too long": {ClusterID: "alpha", Role: "Write", DurationMinutes: 60, Reason: strings.Repeat("r", accessRequestReasonMax+1)},
	}
	for name, in := range cases {
		if err := validateAccessRequestInput(in, testAccessCfg); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// The allow list is case-insensitive and trimmed (it comes from an env list).
	if err := validateAccessRequestInput(ok, config.AccessRequestsConfig{MaxHours: 8, Roles: []string{" write "}}); err != nil {
		t.Fatalf("allow list match should ignore case and spaces: %v", err)
	}
}

func TestUncoveredPermissions_WriteCeiling(t *testing.T) {
	write := []string{
		"menu.*", "resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete",
		"resource.cronjob.suspend", "resource.cronjob.trigger", "resource.secret.reveal", "resource.pod.logfile",
		"resource.helm.read", "resource.helm.rollback", "resource.helm.upgrade", "resource.helm.test", "ai.tool.*",
	}
	if got := uncoveredPermissions(write, write); got != nil {
		t.Fatalf("Write within Write: %v", got)
	}
	read := []string{"menu.workloads", "menu.dashboard", "resource.*.read", "resource.helm.read", "resource.pod.logfile"}
	if got := uncoveredPermissions(read, write); got != nil {
		t.Fatalf("Read within Write: %v", got)
	}
	custom := []string{"resource.pod.read", "resource.deployment.edit", "resource.helm.uninstall", "admin.users.read", "*"}
	got := uncoveredPermissions(custom, write)
	want := []string{"*", "admin.users.read", "resource.helm.uninstall"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("uncovered = %v, want %v", got, want)
	}
	if got := uncoveredPermissions(nil, write); len(got) != 1 {
		t.Fatalf("an empty role must not be requestable: %v", got)
	}
}

func TestCanDecideAccessRequest_RefusesOwn(t *testing.T) {
	req := &repository.AccessRequest{ID: "r1", UserID: "u1"}
	if err := canDecideAccessRequest(auth.TokenPayload{UserID: "u1"}, req); err == nil {
		t.Fatal("own request accepted")
	}
	if err := canDecideAccessRequest(auth.TokenPayload{UserID: "admin"}, req); err != nil {
		t.Fatalf("another admin refused: %v", err)
	}
}

// Re-QA #72 (decision A): the chart's "where to ask" text and link reach the
// console with the access request config; only an http(s) link is passed on.
func TestAccessRequestsConfig_AccessHelp(t *testing.T) {
	for _, c := range []struct{ url, want string }{
		{"https://flex.example.com/forms/123", "https://flex.example.com/forms/123"},
		{"http://intranet/ask", "http://intranet/ask"},
		{"javascript:alert(1)", ""},
		{"flex.example.com/forms", ""},
		{"", ""},
	} {
		cfg := config.Config{}
		cfg.AccessRequests.HelpText = "  Ask in #infra-access  "
		cfg.AccessRequests.HelpURL = c.url
		h := &AuthHandler{cfg: cfg}
		w := httptest.NewRecorder()
		h.AccessRequestsConfig(w, httptest.NewRequest(http.MethodGet, "/api/v1/auth/access-requests/config", nil))
		var got accessRequestsConfigResponse
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.HelpText != "Ask in #infra-access" || got.HelpURL != c.want {
			t.Errorf("url %q: help = %q %q, want text trimmed and url %q", c.url, got.HelpText, got.HelpURL, c.want)
		}
	}
}
