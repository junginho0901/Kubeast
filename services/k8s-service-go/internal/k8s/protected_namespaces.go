package k8s

import (
	"context"
	"log/slog"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
)

// installNamespace and nodeShellNamespace come from ServiceOptions, as impersonationEnabled does.
var installNamespace, nodeShellNamespace string

// protectedFor is the guarded namespaces on one cluster: the install namespace only where Kubeast runs, a cluster
// registered as in-cluster (In-cluster on the setup page), or one a kubeconfig reaches whose kube-system namespace is
// this cluster's (viewer reads it, with the identity the informers use: a credential that may only impersonate cannot).
func protectedFor(info cluster.Info, viewer kubernetes.Interface) protectedns.Namespaces {
	n := protectedns.Namespaces{NodeShell: nodeShellNamespace}
	if info.InCluster || info.IsSelfCluster {
		n.Install = installNamespace
	} else if installNamespace != "" && isInstallCluster(info.ID, viewer) {
		n.Install = installNamespace
	}
	return n
}

// clusterFingerprintTimeout bounds the one read a client bundle makes while it is built: a dead cluster must not hold
// up the requests waiting for it.
const clusterFingerprintTimeout = 3 * time.Second

func kubeSystemUID(viewer kubernetes.Interface) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), clusterFingerprintTimeout)
	defer cancel()
	ns, err := viewer.CoreV1().Namespaces().Get(ctx, "kube-system", metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return string(ns.UID), nil
}

// installClusterUID is the kube-system UID of the cluster Kubeast runs on, "" when it runs outside one or it could not
// be read yet. A value read once stays; a failure is asked again by the next bundle. Tests replace it.
var installClusterUID = func() func() string {
	var mu sync.Mutex
	var known string
	return func() string {
		mu.Lock()
		defer mu.Unlock()
		if known != "" {
			return known
		}
		cfg, err := rest.InClusterConfig()
		if err != nil {
			return ""
		}
		if impersonationEnabled {
			cfg.Impersonate = rest.ImpersonationConfig{UserName: overviewCacheUser, Groups: []string{auth.GroupAuthenticated, auth.GroupViewer}}
		}
		client, err := kubernetes.NewForConfig(cfg)
		if err != nil {
			return ""
		}
		uid, err := kubeSystemUID(client)
		if err != nil {
			slog.Warn("install cluster's kube-system UID not readable", "err", err)
			return ""
		}
		known = uid
		return known
	}
}()

// isInstallCluster compares a registered cluster with the one Kubeast runs on. Not known to match when either UID
// cannot be read, which the log says for the registered one: its install namespace is then an ordinary one.
func isInstallCluster(id cluster.ID, viewer kubernetes.Interface) bool {
	own := installClusterUID()
	if own == "" {
		return false
	}
	uid, err := kubeSystemUID(viewer)
	if err != nil {
		slog.Warn("registered cluster's kube-system UID not readable: cannot tell whether it is the cluster Kubeast runs on", "cluster", id, "err", err)
		return false
	}
	return uid == own
}

// ProtectedNamespaces is the guarded namespaces on the request's cluster, with nothing to ask of the registry once the
// cluster's client is built.
func (s *Service) ProtectedNamespaces(ctx context.Context) protectedns.Namespaces {
	if s == nil {
		return protectedns.Namespaces{}
	}
	if b := s.bundleForCtx(ctx); b != nil {
		return b.protected
	}
	return protectedns.Namespaces{NodeShell: nodeShellNamespace}
}

// ProtectedNamespacesOf is ProtectedNamespaces for a cluster named by id, for the kubeconfig answer tool-server reads.
func (s *Service) ProtectedNamespacesOf(ctx context.Context, id cluster.ID) (protectedns.Namespaces, error) {
	b, err := s.For(ctx, id)
	if err != nil {
		return protectedns.Namespaces{}, err
	}
	return b.protected, nil
}
