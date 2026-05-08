// kubectl shell 호출. main.go 에서 추출 (Phase 3.6.d).
//
// kubectl 바이너리를 exec — kubeconfigPath / token (TOKEN_PASSTHROUGH) 을
// 자동으로 끼워 넣는다. 모든 read/write handler 가 이 두 함수만 거쳐 kubectl
// 을 호출. token 추출 (extractBearerToken) + kubeconfig 경로 결정
// (resolveKubeconfigPath) 도 동거.

package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
)

func runKubectl(ctx context.Context, headers http.Header, args ...string) (string, error) {
	token, err := tokenForKubectl(headers)
	if err != nil {
		return "", err
	}

	finalArgs := make([]string, 0, len(args)+4)
	if kubeconfigPath != "" {
		finalArgs = append(finalArgs, "--kubeconfig", kubeconfigPath)
	}
	if token != "" {
		finalArgs = append(finalArgs, "--token", token)
	}
	finalArgs = append(finalArgs, args...)

	cmd := exec.CommandContext(ctx, "kubectl", finalArgs...)
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
	token, err := tokenForKubectl(headers)
	if err != nil {
		return "", err
	}

	finalArgs := make([]string, 0, len(args)+4)
	if kubeconfigPath != "" {
		finalArgs = append(finalArgs, "--kubeconfig", kubeconfigPath)
	}
	if token != "" {
		finalArgs = append(finalArgs, "--token", token)
	}
	finalArgs = append(finalArgs, args...)

	cmd := exec.CommandContext(ctx, "kubectl", finalArgs...)
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

func tokenForKubectl(headers http.Header) (string, error) {
	token := extractBearerToken(headers)
	if tokenPassthrough && token == "" {
		return "", wrapBadRequest("Bearer token required when TOKEN_PASSTHROUGH is true")
	}
	if tokenPassthrough {
		return token, nil
	}
	return "", nil
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
