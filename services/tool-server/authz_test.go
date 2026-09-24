package main

import (
	"errors"
	"net/http"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

type fakeValidator struct {
	payload auth.TokenPayload
	err     error
}

func (f fakeValidator) Validate(string) (auth.TokenPayload, error) { return f.payload, f.err }

func hdr(token string) http.Header {
	h := http.Header{}
	if token != "" {
		h.Set("Authorization", "Bearer "+token)
	}
	return h
}

func TestAuthorizeToolCall(t *testing.T) {
	v := fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{
		"alpha": {"ai.tool.*"},
		"prod":  {"resource.*.read"},
	}}}
	cases := []struct {
		name, tool, cluster, token string
		validator                  tokenValidator
		wantStatus                 int
	}{
		{"granted on alpha", "k8s_delete_resource", "alpha", "t", v, 0},
		{"same tool refused on prod", "k8s_delete_resource", "prod", "t", v, http.StatusForbidden},
		{"read tool refused on prod (no ai.tool grant)", "k8s_get_resources", "prod", "t", v, http.StatusForbidden},
		{"empty cluster = default, no grant", "k8s_get_resources", "", "t", v, http.StatusForbidden},
		{"missing token", "k8s_get_resources", "alpha", "", v, http.StatusUnauthorized},
		{"invalid token", "k8s_get_resources", "alpha", "t", fakeValidator{err: errors.New("bad")}, http.StatusUnauthorized},
		{"global admin any cluster", "k8s_execute_command", "prod", "t", fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"*"}}}}, 0},
	}
	for _, c := range cases {
		_, status, err := authorizeToolCall(c.validator, hdr(c.token), c.tool, c.cluster)
		if status != c.wantStatus {
			t.Errorf("%s: status %d want %d (err %v)", c.name, status, c.wantStatus, err)
		}
	}
}
