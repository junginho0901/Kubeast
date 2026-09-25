// kubectl shell 호출. main.go 에서 추출 (Phase 3.6.d).
//
// kubectl 바이너리를 exec — 요청 컨텍스트의 kubeconfig 경로와, JWT 에서 검증한
// 사용자를 Kubernetes impersonation(--as / --as-group) 으로 끼워 넣는다. 모든
// read/write handler 가 이 두 함수만 거쳐 kubectl 을 호출한다.

package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func runKubectl(ctx context.Context, headers http.Header, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "kubectl", kubectlArgs(ctx, args)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		errText := strings.TrimSpace(string(output))
		if errText == "" {
			errText = err.Error()
		}
		return "", fmt.Errorf("kubectl failed: %s", errText)
	}

	return string(output), nil
}

func runKubectlWithInput(ctx context.Context, headers http.Header, input string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "kubectl", kubectlArgs(ctx, args)...)
	cmd.Stdin = strings.NewReader(input)
	output, err := cmd.CombinedOutput()
	if err != nil {
		errText := strings.TrimSpace(string(output))
		if errText == "" {
			errText = err.Error()
		}
		return "", fmt.Errorf("kubectl failed: %s", errText)
	}
	return string(output), nil
}

// kubectlArgs prefixes the tool's arguments with the per-request kubeconfig and
// the impersonated identity. The credential in the kubeconfig (or the pod's
// ServiceAccount for in-cluster targets) only needs the "impersonate" verb;
// the cluster authorizes and audits the user named in the JWT.
func kubectlArgs(ctx context.Context, args []string) []string {
	finalArgs := make([]string, 0, len(args)+8)
	if kc := kubeconfigForCtx(ctx); kc != "" {
		finalArgs = append(finalArgs, "--kubeconfig", kc)
	}
	if impersonationEnabled {
		if p, ok := auth.FromContext(ctx); ok {
			finalArgs = append(finalArgs, auth.KubectlImpersonationArgs(p, clusterIDFromCtx(ctx))...)
		}
	}
	return append(finalArgs, args...)
}

func extractBearerToken(headers http.Header) string {
	auth := headers.Get("Authorization")
	if auth == "" {
		return ""
	}
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 {
		return ""
	}
	if strings.ToLower(parts[0]) != "bearer" {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

func resolveKubeconfigPath() string {
	if strings.EqualFold(os.Getenv("TOOL_SERVER_USE_INCLUSTER"), "true") {
		return ""
	}
	if v := os.Getenv("TOOL_SERVER_KUBECONFIG_PATH"); v != "" {
		return v
	}
	if v := os.Getenv("KUBECONFIG_PATH"); v != "" {
		return v
	}
	if v := os.Getenv("KUBECONFIG"); v != "" {
		return v
	}
	return ""
}
