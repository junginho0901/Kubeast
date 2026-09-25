package k8s

import (
	"context"
	"fmt"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// ProbeKubeconfig checks that a kubeconfig can reach its cluster: the exec
// allow-list first (the credential plugin runs in this pod), then a throwaway
// client fetches the API server version. It returns the server version and
// the cluster fingerprint (kube-system namespace UID — stable and unique per
// physical cluster, used to reject duplicate registrations). The fingerprint
// is best-effort: when it cannot be read the version still returns.
// auth-service calls this through the internal validate route for
// registration, rotation and the "test connection" button.
func (s *Service) ProbeKubeconfig(ctx context.Context, blob string, timeout time.Duration) (version, uid string, err error) {
	if err := cluster.CheckKubeconfigExec(blob, execCommands); err != nil {
		return "", "", err
	}
	cfg, err := clientcmd.RESTConfigFromKubeConfig([]byte(blob))
	if err != nil {
		return "", "", fmt.Errorf("invalid kubeconfig: %w", err)
	}
	return probeConfig(ctx, cfg, timeout)
}

// ProbeCluster runs the same check for a registered cluster from its stored
// connection details.
func (s *Service) ProbeCluster(ctx context.Context, id cluster.ID, timeout time.Duration) (version, uid string, err error) {
	info, err := s.registry.Get(ctx, id)
	if err != nil {
		return "", "", err
	}
	var cfg *rest.Config
	switch {
	case info.InCluster || info.IsSelfCluster:
		cfg, err = rest.InClusterConfig()
	case info.KubeconfigBlob != "":
		return s.ProbeKubeconfig(ctx, info.KubeconfigBlob, timeout)
	case info.KubeconfigPath != "":
		cfg, err = clientcmd.BuildConfigFromFlags("", info.KubeconfigPath)
	default:
		return "", "", fmt.Errorf("cluster %s has no connection details", id)
	}
	if err != nil {
		return "", "", err
	}
	return probeConfig(ctx, cfg, timeout)
}

func probeConfig(ctx context.Context, cfg *rest.Config, timeout time.Duration) (version, uid string, err error) {
	cfg.Timeout = timeout
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return "", "", fmt.Errorf("create client: %w", err)
	}
	ver, err := client.Discovery().ServerVersion()
	if err != nil {
		return "", "", fmt.Errorf("connection failed: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ns, nerr := client.CoreV1().Namespaces().Get(ctx, "kube-system", metav1.GetOptions{})
	if nerr != nil {
		return ver.GitVersion, "", nil
	}
	return ver.GitVersion, string(ns.UID), nil
}
