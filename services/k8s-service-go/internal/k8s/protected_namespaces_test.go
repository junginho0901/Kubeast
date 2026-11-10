package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
)

// clusterWithKubeSystem is an API server whose kube-system namespace has this UID, or answers with this status.
func clusterWithKubeSystem(t *testing.T, uid string, status int) kubernetes.Interface {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/namespaces/kube-system") {
			http.NotFound(w, r)
			return
		}
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(&corev1.Namespace{
			TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Namespace"},
			ObjectMeta: metav1.ObjectMeta{Name: "kube-system", UID: types.UID(uid)},
		})
	}))
	t.Cleanup(srv.Close)
	client, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func withInstallCluster(t *testing.T, uid string) {
	t.Helper()
	origUID, origNS, origShell := installClusterUID, installNamespace, nodeShellNamespace
	installClusterUID = func() (string, error) { return uid, nil }
	installNamespace, nodeShellNamespace = "kubeast", "kubeast-node-shell"
	t.Cleanup(func() { installClusterUID, installNamespace, nodeShellNamespace = origUID, origNS, origShell })
}

func TestAKubeconfigToTheClusterKubeastRunsOnGetsTheSameLimits(t *testing.T) {
	withInstallCluster(t, "own-uid")
	got := protectedFor(cluster.Info{ID: "same", Mode: cluster.ModeExternal}, clusterWithKubeSystem(t, "own-uid", 0)).get()
	if got.Install != "kubeast" || got.NodeShell != "kubeast-node-shell" {
		t.Fatalf("protected = %+v", got)
	}
}

func TestAnotherClustersNamespaceOfThatNameStaysOrdinary(t *testing.T) {
	withInstallCluster(t, "own-uid")
	got := protectedFor(cluster.Info{ID: "other", Mode: cluster.ModeExternal}, clusterWithKubeSystem(t, "other-uid", 0)).get()
	if got.Install != "" {
		t.Fatalf("protected = %+v", got)
	}
}

// Until a cluster's kube-system can be read it may be the cluster Kubeast runs on: its namespace of that name is guarded.
func TestAClusterWhoseFingerprintCannotBeReadIsGuardedUntilItIsRead(t *testing.T) {
	withInstallCluster(t, "own-uid")
	for _, status := range []int{http.StatusForbidden, http.StatusInternalServerError} {
		got := protectedFor(cluster.Info{ID: "x", Mode: cluster.ModeExternal}, clusterWithKubeSystem(t, "", status)).get()
		if got.Install != "kubeast" {
			t.Errorf("status %d: protected = %+v", status, got)
		}
	}
}

// A kube-system read that failed while the cluster's client was built is not kept for the client's life: the cluster
// is guarded meanwhile, on the answer tool-server reads and on the client's own requests, and once it answers with
// another cluster's UID its namespace of that name is ordinary again.
func TestAFingerprintThatCouldNotBeReadIsAskedAgain(t *testing.T) {
	withInstallCluster(t, "own-uid")
	var failing atomic.Bool
	failing.Store(true)
	var secretReads atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/namespaces/kube-system"):
			if failing.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(&corev1.Namespace{
				TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Namespace"},
				ObjectMeta: metav1.ObjectMeta{Name: "kube-system", UID: types.UID("other-uid")},
			})
		case strings.Contains(r.URL.Path, "/secrets"):
			secretReads.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"kind":"SecretList","apiVersion":"v1","items":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	kc := strings.Replace(testKubeconfig, "https://127.0.0.1:6443", srv.URL, 1)
	reg := &mockRegistry{def: "x", clusters: map[cluster.ID]cluster.Info{"x": {ID: "x", Mode: cluster.ModeExternal, KubeconfigBlob: kc}}}
	s, err := NewService(context.Background(), reg, false, nil, ServiceOptions{MaxClusters: 20, InstallNamespace: "kubeast", NodeShellNamespace: "kubeast-node-shell"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := cluster.WithID(context.Background(), "x")
	writer := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Email: "write@example.com", Perms: auth.PermissionMatrix{"x": {"resource.*.read"}}, Roles: map[string]string{"x": "Write"}})
	if got := s.ProtectedNamespaces(ctx); got.Install != "kubeast" {
		t.Fatalf("while kube-system cannot be read: %+v", got)
	}
	_, err = s.clientsetCtx(writer).CoreV1().Secrets("kubeast").List(writer, metav1.ListOptions{})
	if !apierrors.IsForbidden(err) || secretReads.Load() != 0 {
		t.Fatalf("the client's own requests while it cannot be read: err %v, the cluster was asked %d times", err, secretReads.Load())
	}

	failing.Store(false)
	installRecheck = 0
	t.Cleanup(func() { installRecheck = 10 * time.Second })
	if got, err := s.ProtectedNamespacesOf(context.Background(), "x"); err != nil || got.Install != "" {
		t.Fatalf("once it answers as another cluster: %+v, %v", got, err)
	}
	if _, err = s.clientsetCtx(writer).CoreV1().Secrets("kubeast").List(writer, metav1.ListOptions{}); err != nil || secretReads.Load() != 1 {
		t.Fatalf("the client's own requests once it is known: err %v, the cluster was asked %d times", err, secretReads.Load())
	}
}

// A re-ask reads the cluster over the network: the requests that come meanwhile get the rules as they stand, guarded,
// without waiting for it, and one ask runs at a time; its answer is what the next request gets.
func TestAReAskDoesNotHoldTheClustersRequests(t *testing.T) {
	prev := installRecheck
	installRecheck = 0
	t.Cleanup(func() { installRecheck = prev })
	release := make(chan struct{})
	var unblock sync.Once
	t.Cleanup(func() { unblock.Do(func() { close(release) }) })
	var asks atomic.Int32
	g := &guardedNamespaces{rules: protectedns.Namespaces{Install: "kubeast", NodeShell: "kubeast-node-shell"}, install: "kubeast"}
	g.ask = func() (bool, bool) {
		asks.Add(1)
		<-release
		return false, true
	}

	go g.get() // the request that starts the re-ask
	for deadline := time.Now().Add(2 * time.Second); asks.Load() == 0; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("no re-ask started")
		}
	}
	const others = 20
	got := make(chan protectedns.Namespaces, others)
	for range others {
		go func() { got <- g.get() }()
	}
	for i := range others {
		select {
		case rules := <-got:
			if rules.Install != "kubeast" {
				t.Errorf("a request during the re-ask got %+v, want the namespace still guarded", rules)
			}
		case <-time.After(200 * time.Millisecond):
			t.Fatalf("%d of %d requests returned within 200 ms: the others wait behind the re-ask", i, others)
		}
	}
	if n := asks.Load(); n != 1 {
		t.Errorf("%d asks ran during one re-ask, want one", n)
	}
	t.Logf("%d requests returned during the re-ask, guarded; asks %d", others, asks.Load())

	unblock.Do(func() { close(release) })
	for deadline := time.Now().Add(2 * time.Second); g.get().Install != ""; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("after the answer another cluster: %+v", g.get())
		}
	}
	if n := asks.Load(); n != 1 {
		t.Errorf("%d asks in all, want one: a known answer is not asked again", n)
	}
}

// The cluster Kubeast runs on could not be read either: no kubeconfig cluster is known not to be it, so each stays guarded.
func TestWhileKubeastsOwnClusterCannotBeReadAKubeconfigClusterIsGuarded(t *testing.T) {
	withInstallCluster(t, "")
	installClusterUID = func() (string, error) { return "", errors.New("the API server did not answer") }
	got := protectedFor(cluster.Info{ID: "other", Mode: cluster.ModeExternal}, clusterWithKubeSystem(t, "other-uid", 0)).get()
	if got.Install != "kubeast" {
		t.Fatalf("protected = %+v", got)
	}
}

func TestOutsideAClusterNothingIsCompared(t *testing.T) {
	withInstallCluster(t, "")
	var viewer kubernetes.Interface // asked for nothing: nil would panic
	if got := protectedFor(cluster.Info{ID: "x"}, viewer).get(); got.Install != "" {
		t.Fatalf("protected = %+v", got)
	}
}

func TestAnInClusterRegistrationAsksNothing(t *testing.T) {
	withInstallCluster(t, "own-uid")
	var viewer kubernetes.Interface // nil: must not be asked
	for _, info := range []cluster.Info{{InCluster: true}, {IsSelfCluster: true}} {
		if got := protectedFor(info, viewer).get(); got.Install != "kubeast" {
			t.Fatalf("protected = %+v", got)
		}
	}
}
