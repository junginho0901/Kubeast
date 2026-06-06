package handler

import "testing"

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
