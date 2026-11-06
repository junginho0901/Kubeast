package k8s

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
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
	installClusterUID = func() string { return uid }
	installNamespace, nodeShellNamespace = "kubeast", "kubeast-node-shell"
	t.Cleanup(func() { installClusterUID, installNamespace, nodeShellNamespace = origUID, origNS, origShell })
}

func TestAKubeconfigToTheClusterKubeastRunsOnGetsTheSameLimits(t *testing.T) {
	withInstallCluster(t, "own-uid")
	got := protectedFor(cluster.Info{ID: "same", Mode: cluster.ModeExternal}, clusterWithKubeSystem(t, "own-uid", 0))
	if got.Install != "kubeast" || got.NodeShell != "kubeast-node-shell" {
		t.Fatalf("protected = %+v", got)
	}
}

func TestAnotherClustersNamespaceOfThatNameStaysOrdinary(t *testing.T) {
	withInstallCluster(t, "own-uid")
	got := protectedFor(cluster.Info{ID: "other", Mode: cluster.ModeExternal}, clusterWithKubeSystem(t, "other-uid", 0))
	if got.Install != "" {
		t.Fatalf("protected = %+v", got)
	}
}

func TestAClusterWhoseFingerprintCannotBeReadIsNotTakenForTheInstallCluster(t *testing.T) {
	withInstallCluster(t, "own-uid")
	for _, status := range []int{http.StatusForbidden, http.StatusInternalServerError} {
		got := protectedFor(cluster.Info{ID: "x", Mode: cluster.ModeExternal}, clusterWithKubeSystem(t, "", status))
		if got.Install != "" {
			t.Errorf("status %d: protected = %+v", status, got)
		}
	}
}

func TestOutsideAClusterNothingIsCompared(t *testing.T) {
	withInstallCluster(t, "")
	var viewer kubernetes.Interface // asked for nothing: nil would panic
	if got := protectedFor(cluster.Info{ID: "x"}, viewer); got.Install != "" {
		t.Fatalf("protected = %+v", got)
	}
}

func TestAnInClusterRegistrationAsksNothing(t *testing.T) {
	withInstallCluster(t, "own-uid")
	var viewer kubernetes.Interface // nil: must not be asked
	for _, info := range []cluster.Info{{InCluster: true}, {IsSelfCluster: true}} {
		if got := protectedFor(info, viewer); got.Install != "kubeast" {
			t.Fatalf("protected = %+v", got)
		}
	}
}
