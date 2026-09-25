package cluster

import (
	"strings"
	"testing"
)

func execKubeconfig(command string, env string) string {
	b := &strings.Builder{}
	b.WriteString(`apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://example:6443
contexts:
- name: c
  context: {cluster: c, user: u}
current-context: c
users:
- name: u
  user:
`)
	if command == "" {
		b.WriteString("    token: abc\n")
		return b.String()
	}
	b.WriteString("    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: " + command + "\n      args: [token, -i, prod]\n")
	if env != "" {
		b.WriteString("      env:\n      - name: " + env + "\n        value: x\n")
	}
	return b.String()
}

func TestCheckKubeconfigExec(t *testing.T) {
	allow := []string{"aws-iam-authenticator"}
	cases := []struct {
		name    string
		blob    string
		allow   []string
		wantErr string
	}{
		{"no exec section passes", execKubeconfig("", ""), allow, ""},
		{"allowed command", execKubeconfig("aws-iam-authenticator", ""), allow, ""},
		{"allowed command by absolute path", execKubeconfig("/usr/local/bin/aws-iam-authenticator", ""), allow, ""},
		{"other command rejected", execKubeconfig("/bin/sh", ""), allow, `exec command "/bin/sh" is not allowed`},
		{"aws cli rejected unless listed", execKubeconfig("aws", ""), allow, `exec command "aws" is not allowed`},
		{"aws cli allowed when listed", execKubeconfig("aws", ""), []string{"aws-iam-authenticator", "aws"}, ""},
		{"static credential env rejected", execKubeconfig("aws-iam-authenticator", "AWS_SECRET_ACCESS_KEY"), allow, "exec env AWS_SECRET_ACCESS_KEY is not allowed"},
		{"region env is fine", execKubeconfig("aws-iam-authenticator", "AWS_REGION"), allow, ""},
		{"empty allow-list forbids exec", execKubeconfig("aws-iam-authenticator", ""), nil, "is not allowed"},
		{"invalid yaml", "not: [a kubeconfig", allow, "invalid kubeconfig"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := CheckKubeconfigExec(tc.blob, tc.allow)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}
