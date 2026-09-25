package k8s

import (
	"context"
	"strings"
	"testing"
	"time"
)

const probeKubeconfigTemplate = `apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://127.0.0.1:1
contexts:
- name: c
  context: {cluster: c, user: u}
current-context: c
users:
- name: u
  user:
    %s
`

func TestProbeKubeconfig_RejectsDisallowedExecBeforeDialing(t *testing.T) {
	execCommands = []string{"aws-iam-authenticator"}
	s := &Service{}
	blob := strings.Replace(probeKubeconfigTemplate, "%s",
		"exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: /bin/sh\n      args: [-c, id]", 1)
	start := time.Now()
	_, _, err := s.ProbeKubeconfig(context.Background(), blob, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("want exec allow-list error, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("allow-list check must not dial: took %s", time.Since(start))
	}
}

func TestProbeKubeconfig_ReportsConnectionFailure(t *testing.T) {
	s := &Service{}
	blob := strings.Replace(probeKubeconfigTemplate, "%s", "token: abc", 1)
	_, _, err := s.ProbeKubeconfig(context.Background(), blob, 3*time.Second)
	if err == nil || !strings.Contains(err.Error(), "connection failed") {
		t.Fatalf("want connection failure against a closed port, got %v", err)
	}
}
