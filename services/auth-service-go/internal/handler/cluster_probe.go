package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// validateKubeconfigStatic runs the checks that need no network: valid YAML
// with clusters + users, and the exec credential-plugin allow-list. The
// plugin a kubeconfig names runs inside the k8s-service and tool-server pods,
// so only known binaries pass and no static cloud keys may be embedded.
func validateKubeconfigStatic(kubeconfig string, execAllow []string) error {
	if err := validateKubeconfigYAML(kubeconfig); err != nil {
		return err
	}
	return cluster.CheckKubeconfigExec(kubeconfig, execAllow)
}

// forwardCallerCredential copies the caller's credential onto an internal
// request: the Bearer header, or the browser's session cookie re-sent as
// Bearer (k8s-service internal routes take either).
func forwardCallerCredential(r *http.Request, req *http.Request, cookieName string) {
	if authz := r.Header.Get("Authorization"); authz != "" {
		req.Header.Set("Authorization", authz)
	} else if c, err := r.Cookie(cookieName); err == nil && c.Value != "" {
		req.Header.Set("Authorization", "Bearer "+c.Value)
	}
}

// probeKubeconfig asks k8s-service to dial the cluster a kubeconfig points at
// and returns the server version and the cluster fingerprint (kube-system
// namespace UID). The probe runs there because a kubeconfig's credential
// plugin (aws-iam-authenticator) must execute in the pod that holds the cloud
// identity; auth-service has neither the binary nor a role.
func probeKubeconfig(r *http.Request, cfg config.Config, kubeconfig string) (version, uid string, err error) {
	body, _ := json.Marshal(map[string]string{"kubeconfig": kubeconfig})
	return callProbe(r, cfg, "/internal/clusters/validate", body)
}

// probeCluster does the same for a registered cluster, from its stored
// connection details.
func probeCluster(r *http.Request, cfg config.Config, id cluster.ID) (version, uid string, err error) {
	return callProbe(r, cfg, fmt.Sprintf("/internal/clusters/%s/validate", id), nil)
}

func callProbe(r *http.Request, cfg config.Config, path string, body []byte) (string, string, error) {
	base := strings.TrimRight(cfg.K8sServiceURL, "/")
	if base == "" {
		return "", "", errors.New("k8s-service URL not configured")
	}
	ctx, cancel := context.WithTimeout(r.Context(), clusterValidateTimeout+5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	forwardCallerCredential(r, req, cfg.AuthCookieName)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("k8s-service unreachable: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		ServerVersion string `json:"server_version"`
		UID           string `json:"uid"`
		Detail        string `json:"detail"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != http.StatusOK {
		if out.Detail == "" {
			out.Detail = fmt.Sprintf("k8s-service returned %d", resp.StatusCode)
		}
		return "", "", errors.New(out.Detail)
	}
	return out.ServerVersion, out.UID, nil
}
