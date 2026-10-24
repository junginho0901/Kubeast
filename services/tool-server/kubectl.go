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
	"strconv"
	"strings"

	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// outputMaxBytes caps what one kubectl call hands back to the model: the tool
// result goes into the prompt and the chat history, so an unbounded `logs` or
// `get -o json` would blow the context (and memory) before anything else
// (second review M30). TOOL_OUTPUT_MAX_BYTES overrides the 1 MiB default.
var outputMaxBytes = envInt("TOOL_OUTPUT_MAX_BYTES", 1<<20)

const truncatedMarker = "\n… [output truncated by tool-server: %d bytes limit]\n"

func envInt(name string, def int) int {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// capOutput truncates output to outputMaxBytes with a visible marker.
func capOutput(output []byte) string {
	if len(output) <= outputMaxBytes {
		return string(output)
	}
	return string(output[:outputMaxBytes]) + fmt.Sprintf(truncatedMarker, outputMaxBytes)
}

// kubectlExec runs the kubectl binary; tests replace it to script outputs.
var kubectlExec = func(ctx context.Context, args []string, stdin *string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "kubectl", args...)
	if stdin != nil {
		cmd.Stdin = strings.NewReader(*stdin)
	}
	return cmd.CombinedOutput()
}

func runKubectl(ctx context.Context, headers http.Header, args ...string) (string, error) {
	argv, done, err := kubectlCommand(ctx, args)
	if err != nil {
		return "", err
	}
	defer done()
	output, err := kubectlExec(ctx, argv, nil)
	if err != nil {
		errText := strings.TrimSpace(capOutput(output))
		if errText == "" {
			errText = err.Error()
		}
		return "", fmt.Errorf("kubectl failed: %s", errText)
	}

	return capOutput(output), nil
}

func runKubectlWithInput(ctx context.Context, headers http.Header, input string, args ...string) (string, error) {
	argv, done, err := kubectlCommand(ctx, args)
	if err != nil {
		return "", err
	}
	defer done()
	output, err := kubectlExec(ctx, argv, &input)
	if err != nil {
		errText := strings.TrimSpace(capOutput(output))
		if errText == "" {
			errText = err.Error()
		}
		return "", fmt.Errorf("kubectl failed: %s", errText)
	}
	return capOutput(output), nil
}

// kubectlCommand is the argv of one kubectl run and what to clean up after it.
// Through the loopback proxy (kubeproxy.go) kubectl names only the proxy; the
// proxy adds the cluster credential, the impersonated user and an Audit-ID per
// request and lists the request for the call. Without it, kubectlArgs.
func kubectlCommand(ctx context.Context, args []string) ([]string, func(), error) {
	if kubectlProxy == nil {
		return kubectlArgs(ctx, args), func() {}, nil
	}
	var imp rest.ImpersonationConfig
	if impersonationEnabled {
		if p, ok := auth.FromContext(ctx); ok {
			imp.UserName, imp.Groups = p.Impersonation(clusterIDFromCtx(ctx))
		}
	}
	rec := accesstrail.FromContext(ctx)
	if rec == nil {
		rec = &accesstrail.Recorder{}
	}
	path, done, err := kubectlProxy.prepare(clusterIDFromCtx(ctx), kubeconfigForCtx(ctx), imp, rec)
	if err != nil {
		return nil, nil, fmt.Errorf("kubectl proxy: %w", err)
	}
	return append([]string{"--kubeconfig", path}, args...), done, nil
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
