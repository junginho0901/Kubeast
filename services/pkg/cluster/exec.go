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
func CheckKubeconfigExec(blob string, allow []string) error {
	cfg, err := clientcmd.Load([]byte(blob))
	if err != nil {
		return fmt.Errorf("invalid kubeconfig: %w", err)
	}
	for name, ai := range cfg.AuthInfos {
		if ai == nil || ai.Exec == nil {
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
