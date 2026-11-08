package k8s

import (
	"context"
	"log/slog"
	"net/http"
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
func protectedFor(info cluster.Info, viewer kubernetes.Interface) *guardedNamespaces {
	g := &guardedNamespaces{rules: protectedns.Namespaces{NodeShell: nodeShellNamespace}}
	if info.InCluster || info.IsSelfCluster {
		g.rules.Install = installNamespace
	} else if installNamespace != "" {
		install, id := installNamespace, info.ID
		// guarded until a read tells: the namespace holds the sign-in key if this is the cluster Kubeast runs on
		g.install, g.rules.Install = install, install
		g.ask = func() (bool, bool) { return isInstallCluster(id, viewer) }
		g.decide()
	}
	return g
}

// installRecheck keeps the asks of a cluster whose kube-system UID could not be read to one per interval, however busy.
var installRecheck = 10 * time.Second

// guardedNamespaces is one cluster's protectedns.Namespaces; while a failed install-cluster read is asked again on a later use the namespace stays guarded.
type guardedNamespaces struct {
	mu      sync.Mutex
	rules   protectedns.Namespaces
	install string
	ask     func() (same, known bool) // nil once the answer is known
	askedAt time.Time
	asking  bool // a re-ask is reading the cluster, outside mu
}

// decide is the first ask, while the client is built and nothing else holds g.
func (g *guardedNamespaces) decide() {
	g.askedAt = time.Now()
	g.settle(g.ask())
}

// settle keeps a known answer; the caller holds mu, or nothing else holds g yet.
func (g *guardedNamespaces) settle(same, known bool) {
	if !known {
		return
	}
	g.ask = nil
	if !same {
		g.rules.Install = ""
	}
}

// get is the cluster's guarded namespaces now. When the last ask could not tell, this call asks again outside mu, one
// at a time, so the other requests get the rules as they stand, still guarded, without waiting for the cluster.
func (g *guardedNamespaces) get() (rules protectedns.Namespaces) {
	if g == nil {
		return protectedns.Namespaces{}
	}
	g.mu.Lock()
	ask := g.ask
	if ask == nil || g.asking || time.Since(g.askedAt) < installRecheck {
		defer g.mu.Unlock()
		return g.rules
	}
	g.asking, g.askedAt = true, time.Now()
	g.mu.Unlock()

	same, known := false, false
	// also after a panic in ask, so a later request asks again
	defer func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		g.asking = false
		g.settle(same, known)
		rules = g.rules
	}()
	same, known = ask()
	return rules
}

// guardedTransport holds each request to the rules of the moment, which a later ask may narrow.
type guardedTransport struct {
	base      http.RoundTripper
	rules     *guardedNamespaces
	clusterID string
	pinned    *auth.TokenPayload
}

func (t *guardedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if t.pinned != nil {
		return protectedns.Pinned(t.base, t.rules.get(), t.clusterID, *t.pinned).RoundTrip(req)
	}
	return protectedns.RoundTripper(t.base, t.rules.get(), t.clusterID).RoundTrip(req)
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

// installClusterUID is the kube-system UID of the cluster Kubeast runs on, "" without an error when it runs outside
// one, an error when it could not be read yet. A value read once stays; a failure is asked again. Tests replace it.
var installClusterUID = func() func() (string, error) {
	var mu sync.Mutex
	var known string
	return func() (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if known != "" {
			return known, nil
		}
		cfg, err := rest.InClusterConfig()
		if err != nil {
			return "", nil
		}
		if impersonationEnabled {
			cfg.Impersonate = rest.ImpersonationConfig{UserName: overviewCacheUser, Groups: []string{auth.GroupAuthenticated, auth.GroupViewer}}
		}
		client, err := kubernetes.NewForConfig(cfg)
		if err != nil {
			return "", err
		}
		uid, err := kubeSystemUID(client)
		if err != nil {
			slog.Warn("install cluster's kube-system UID not readable", "err", err)
			return "", err
		}
		known = uid
		return known, nil
	}
}()

// isInstallCluster compares a registered cluster with the one Kubeast runs on. Not known when either UID cannot be
// read, which the log says for the registered one: its install namespace stays guarded until a later ask tells.
func isInstallCluster(id cluster.ID, viewer kubernetes.Interface) (same, known bool) {
	own, err := installClusterUID()
	if err != nil {
		return false, false
	}
	if own == "" {
		return false, true // outside a cluster no registered cluster is the one Kubeast runs on
	}
	uid, err := kubeSystemUID(viewer)
	if err != nil {
		slog.Warn("registered cluster's kube-system UID not readable: Kubeast's own namespace name stays guarded there until a later read tells whether it is the cluster Kubeast runs on", "cluster", id, "err", err)
		return false, false
	}
	return uid == own, true
}

// ProtectedNamespaces is the guarded namespaces on the request's cluster, with nothing to ask of the registry once the
// cluster's client is built.
func (s *Service) ProtectedNamespaces(ctx context.Context) protectedns.Namespaces {
	if s == nil {
		return protectedns.Namespaces{}
	}
	if b := s.bundleForCtx(ctx); b != nil {
		return b.protected.get()
	}
	return protectedns.Namespaces{NodeShell: nodeShellNamespace}
}

// ProtectedNamespacesOf is ProtectedNamespaces for a cluster named by id, for the kubeconfig answer tool-server reads.
func (s *Service) ProtectedNamespacesOf(ctx context.Context, id cluster.ID) (protectedns.Namespaces, error) {
	b, err := s.For(ctx, id)
	if err != nil {
		return protectedns.Namespaces{}, err
	}
	return b.protected.get(), nil
}
