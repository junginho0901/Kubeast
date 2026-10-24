package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// The check names two namespaces in its query, so the handler applies the
// namespace grant itself; everything refused here never reaches the cluster.
func TestCheckNetworkPolicyRefusals(t *testing.T) {
	h := &Handler{}
	scoped := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"c": {"resource.*.read"}}, Namespaces: map[string][]string{"c": {"shop"}}}
	noNetpol := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"c": {"resource.pod.read"}}}
	cases := []struct {
		name    string
		payload auth.TokenPayload
		query   string
		status  int
		body    string
	}{
		{"destination outside the grant", scoped, "src=pod/shop/a&dst=pod/db/b&port=80", http.StatusForbidden, "namespace db"},
		{"source outside the grant", scoped, "src=deployment/db/a&dst=service/shop/b", http.StatusForbidden, "namespace db"},
		{"bad source", scoped, "src=secret/shop/a&dst=10.0.0.1&port=80", http.StatusBadRequest, "kind"},
		{"service as source", scoped, "src=service/shop/a&dst=10.0.0.1&port=80", http.StatusBadRequest, "kind"},
		{"bad protocol", scoped, "src=pod/shop/a&dst=10.0.0.1&port=80&protocol=icmp", http.StatusBadRequest, "protocol"},
		{"no networkpolicy read", noNetpol, "src=pod/shop/a&dst=pod/shop/b&port=80", http.StatusForbidden, "resource.networkpolicy.read"},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/networkpolicies/check?"+tc.query, nil)
		ctx := auth.WithPayload(cluster.WithID(req.Context(), cluster.ID("c")), tc.payload)
		rec := httptest.NewRecorder()
		h.CheckNetworkPolicy(rec, req.WithContext(ctx))
		if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.body) {
			t.Errorf("%s: %d %s, want %d containing %q", tc.name, rec.Code, rec.Body.String(), tc.status, tc.body)
		}
	}
}
