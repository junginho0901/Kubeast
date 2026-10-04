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

// A registered kubeconfig must not disable TLS verification, route through a
// proxy, or reference files on the pod's filesystem (second review M28).
func TestCheckKubeconfigExec_RejectsUnsafeClusterAndUserFields(t *testing.T) {
	const head = "apiVersion: v1\nkind: Config\ncontexts:\n- name: c\n  context: {cluster: c, user: u}\ncurrent-context: c\n"
	cases := []struct {
		name string
		blob string
		want string
	}{
		{"insecure-skip-tls-verify", head + "clusters:\n- name: c\n  cluster:\n    server: https://example:6443\n    insecure-skip-tls-verify: true\nusers:\n- name: u\n  user:\n    token: abc\n", "insecure-skip-tls-verify"},
		{"proxy-url", head + "clusters:\n- name: c\n  cluster:\n    server: https://example:6443\n    proxy-url: http://proxy.example:3128\nusers:\n- name: u\n  user:\n    token: abc\n", "proxy-url"},
		{"certificate-authority file", head + "clusters:\n- name: c\n  cluster:\n    server: https://example:6443\n    certificate-authority: /etc/ssl/ca.crt\nusers:\n- name: u\n  user:\n    token: abc\n", "certificate-authority"},
		{"client-certificate file", head + "clusters:\n- name: c\n  cluster:\n    server: https://example:6443\nusers:\n- name: u\n  user:\n    client-certificate: /tmp/c.crt\n    client-key: /tmp/c.key\n", "client-certificate"},
		{"tokenFile", head + "clusters:\n- name: c\n  cluster:\n    server: https://example:6443\nusers:\n- name: u\n  user:\n    tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token\n", "tokenFile"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := CheckKubeconfigExec(tc.blob, []string{"aws-iam-authenticator"})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error mentioning %q, got %v", tc.want, err)
			}
		})
	}
	inline := head + "clusters:\n- name: c\n  cluster:\n    server: https://example:6443\n    certificate-authority-data: Zm9v\nusers:\n- name: u\n  user:\n    client-certificate-data: Zm9v\n    client-key-data: YmFy\n"
	if err := CheckKubeconfigExec(inline, nil); err != nil {
		t.Fatalf("inline data fields must pass: %v", err)
	}
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
