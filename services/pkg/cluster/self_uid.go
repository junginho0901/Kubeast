package cluster

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// inClusterConfig is the ServiceAccount config of the cluster Kubeast runs in; a variable so tests stand in for it.
var inClusterConfig = rest.InClusterConfig

// SelfUID reads the kube-system namespace UID of the cluster Kubeast runs in — the fingerprint an external
// registration's probe reads from a kubeconfig — so the same cluster is matched whichever way it was registered.
// auth-service may get that one namespace (the chart's ClusterRole <release>-auth-service-self-uid).
var SelfUID = func(ctx context.Context) (string, error) {
	cfg, err := inClusterConfig()
	if err != nil {
		return "", err
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return "", err
	}
	ns, err := client.CoreV1().Namespaces().Get(ctx, "kube-system", metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return string(ns.UID), nil
}

// SameClusterError is an in-cluster registration of a cluster already registered under another id: in-cluster, or by a
// kubeconfig whose kube-system UID is this cluster's.
type SameClusterError struct{ ID ID }

func (e *SameClusterError) Error() string {
	return fmt.Sprintf("This cluster is already registered as '%s'.", e.ID)
}

// FillSelfUID records the kube-system UID on the in-cluster rows registered without one (by a release before the
// in-cluster registration read it, or while it could not be read), so a kubeconfig of the same cluster is matched.
// It reads nothing while every in-cluster row has one.
func (r *PostgresRegistry) FillSelfUID(ctx context.Context) error {
	var missing int
	if err := r.pool.QueryRow(ctx, `SELECT count(*) FROM clusters WHERE is_self_cluster AND cluster_uid IS NULL`).Scan(&missing); err != nil {
		return err
	}
	if missing == 0 {
		return nil
	}
	uid, err := SelfUID(ctx)
	if err != nil {
		return fmt.Errorf("read the kube-system UID of this cluster: %w", err)
	}
	if uid == "" {
		return nil
	}
	_, err = r.pool.Exec(ctx, `UPDATE clusters SET cluster_uid = $1, updated_at = NOW() WHERE is_self_cluster AND cluster_uid IS NULL`, uid)
	return err
}
