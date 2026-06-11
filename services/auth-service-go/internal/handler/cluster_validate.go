package handler

import (
	"context"
	"fmt"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// validateKubeconfig builds a throwaway client from the given kubeconfig bytes
// and confirms connectivity by fetching the API server version, bounded by
// timeout. It returns the server version string ("v1.29.2") and the cluster's
// fingerprint (the kube-system namespace UID — stable + unique per physical
// cluster, used to reject duplicate registrations), or an error describing why
// the connection failed. The fingerprint is best-effort: if it can't be read,
// version still returns so connectivity isn't blocked on it.
func validateKubeconfig(kubeconfigBytes []byte, timeout time.Duration) (version, uid string, err error) {
	cfg, err := clientcmd.RESTConfigFromKubeConfig(kubeconfigBytes)
	if err != nil {
		return "", "", fmt.Errorf("invalid kubeconfig: %w", err)
	}
	cfg.Timeout = timeout

	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return "", "", fmt.Errorf("create client: %w", err)
	}

	ver, err := client.Discovery().ServerVersion()
	if err != nil {
		return "", "", fmt.Errorf("connection failed: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	ns, nerr := client.CoreV1().Namespaces().Get(ctx, "kube-system", metav1.GetOptions{})
	if nerr != nil {
		return ver.GitVersion, "", nil
	}
	return ver.GitVersion, string(ns.UID), nil
}
