package k8s

import (
	"context"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
)

// installNamespace and nodeShellNamespace come from ServiceOptions, as impersonationEnabled does.
var installNamespace, nodeShellNamespace string

// protectedFor is the guarded namespaces on one cluster: the install namespace only where Kubeast runs, a cluster
// registered as in-cluster (In-cluster on the setup page). A kubeconfig is another cluster to the registry.
func protectedFor(info cluster.Info) protectedns.Namespaces {
	n := protectedns.Namespaces{NodeShell: nodeShellNamespace}
	if info.InCluster || info.IsSelfCluster {
		n.Install = installNamespace
	}
	return n
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
