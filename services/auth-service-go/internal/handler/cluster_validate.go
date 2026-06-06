package handler

import (
	"fmt"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// validateKubeconfig builds a throwaway client from the given kubeconfig bytes
// and confirms connectivity by fetching the API server version, bounded by
// timeout. It returns the server version string ("v1.29.2") on success, or an
// error describing why the connection failed. Used by the "test connection"
// button before registration and by re-validation of a registered cluster.
func validateKubeconfig(kubeconfigBytes []byte, timeout time.Duration) (string, error) {
	cfg, err := clientcmd.RESTConfigFromKubeConfig(kubeconfigBytes)
	if err != nil {
		return "", fmt.Errorf("invalid kubeconfig: %w", err)
	}
	cfg.Timeout = timeout

	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return "", fmt.Errorf("create client: %w", err)
	}

	ver, err := client.Discovery().ServerVersion()
	if err != nil {
		return "", fmt.Errorf("connection failed: %w", err)
	}
	return ver.GitVersion, nil
}
