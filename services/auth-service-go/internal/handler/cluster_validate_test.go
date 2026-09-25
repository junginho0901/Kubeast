package handler

import (
	"strings"
	"testing"
)

func TestValidateKubeconfigYAML(t *testing.T) {
	valid := `
apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://example:6443
users:
- name: u
  user:
    token: abc
contexts: []
`
	if err := validateKubeconfigYAML(valid); err != nil {
		t.Fatalf("valid kubeconfig rejected: %v", err)
	}

	cases := map[string]string{
		"not yaml at all: : :\n\t- broken": "::: not: valid: yaml: [",
		"missing clusters":                 "users:\n- name: u\n",
		"missing users":                    "clusters:\n- name: c\n",
	}
	for name, kc := range cases {
		t.Run(name, func(t *testing.T) {
			if err := validateKubeconfigYAML(kc); err == nil {
				t.Errorf("expected error for %q, got nil", name)
			}
		})
	}
}

func TestValidateKubeconfigStatic_ExecAllowList(t *testing.T) {
	withExec := func(cmd string) string {
		return `apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://example:6443
contexts: []
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: ` + cmd + `
      args: [token, -i, prod]
`
	}
	allow := []string{"aws-iam-authenticator"}
	if err := validateKubeconfigStatic(withExec("aws-iam-authenticator"), allow); err != nil {
		t.Fatalf("allow-listed plugin rejected: %v", err)
	}
	err := validateKubeconfigStatic(withExec("/bin/sh"), allow)
	if err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("other command must be rejected, got %v", err)
	}
	err = validateKubeconfigStatic(withExec("aws-iam-authenticator"), nil)
	if err == nil {
		t.Fatalf("empty allow-list must reject exec plugins")
	}
}
