package cluster

import (
	"fmt"
	"path/filepath"
	"strings"

	"k8s.io/client-go/tools/clientcmd"
)

// DefaultExecCommands is the credential-plugin allow-list applied when
// KUBECONFIG_EXEC_COMMANDS is unset: EKS IAM authentication only.
const DefaultExecCommands = "aws-iam-authenticator"

// staticCredentialEnv are exec env names that would embed long-lived AWS keys
// in a kubeconfig. The pod's own credentials (IRSA) are the only source.
var staticCredentialEnv = []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"}

// CheckKubeconfigExec rejects a kubeconfig whose exec credential plugin is
// not on the allow-list or sets static AWS credentials. A registered
// kubeconfig is executed inside the k8s-service and tool-server pods, so an
// arbitrary command would run there with the pod's identity. Commands are
// matched on their base name, so an absolute path to an allowed binary
// passes. A kubeconfig without an exec section always passes; an empty
// allow-list forbids exec plugins altogether.
//
// It also rejects what a registered kubeconfig must never carry (second
// review M28): `insecure-skip-tls-verify` (the API server would go
// unverified), `proxy-url` (traffic would be routed through an arbitrary
// host) and file references — `certificate-authority`, `client-certificate`,
// `client-key`, `tokenFile` — which would point into the pod's own filesystem;
// the inline `*-data` fields are the supported form.
func CheckKubeconfigExec(blob string, allow []string) error {
	cfg, err := clientcmd.Load([]byte(blob))
	if err != nil {
		return fmt.Errorf("invalid kubeconfig: %w", err)
	}
	for name, c := range cfg.Clusters {
		if c == nil {
			continue
		}
		if c.InsecureSkipTLSVerify {
			return fmt.Errorf("cluster %q: insecure-skip-tls-verify is not allowed; provide certificate-authority-data", name)
		}
		if strings.TrimSpace(c.ProxyURL) != "" {
			return fmt.Errorf("cluster %q: proxy-url is not allowed", name)
		}
		if strings.TrimSpace(c.CertificateAuthority) != "" {
			return fmt.Errorf("cluster %q: certificate-authority must be inline (certificate-authority-data), not a file path", name)
		}
	}
	for name, ai := range cfg.AuthInfos {
		if ai == nil {
			continue
		}
		switch {
		case strings.TrimSpace(ai.ClientCertificate) != "":
			return fmt.Errorf("user %q: client-certificate must be inline (client-certificate-data), not a file path", name)
		case strings.TrimSpace(ai.ClientKey) != "":
			return fmt.Errorf("user %q: client-key must be inline (client-key-data), not a file path", name)
		case strings.TrimSpace(ai.TokenFile) != "":
			return fmt.Errorf("user %q: tokenFile is not allowed; the kubeconfig must hold no file references", name)
		}
		if ai.Exec == nil {
			continue
		}
		cmd := filepath.Base(strings.TrimSpace(ai.Exec.Command))
		if !containsString(allow, cmd) {
			return fmt.Errorf("user %q: exec command %q is not allowed (allowed: %s)",
				name, ai.Exec.Command, strings.Join(allow, ", "))
		}
		for _, e := range ai.Exec.Env {
			if containsString(staticCredentialEnv, strings.ToUpper(e.Name)) {
				return fmt.Errorf("user %q: exec env %s is not allowed; the kubeconfig must hold no static credentials", name, e.Name)
			}
		}
	}
	return nil
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if strings.TrimSpace(v) == s {
			return true
		}
	}
	return false
}
