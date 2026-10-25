package k8s

import (
	"context"
	"errors"
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
)

func ownedPod(name, generateName, kind, owner string, labels map[string]string) *corev1.Pod {
	yes := true
	p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "shop", GenerateName: generateName, Labels: labels}}
	if kind != "" {
		p.OwnerReferences = []metav1.OwnerReference{{Kind: "Node", Name: "n1"}, {Kind: kind, Name: owner, Controller: &yes}}
	}
	return p
}

// The cases of Cilium v1.20.4 pkg/k8s/utils/workload_test.go (the naming the Hubble agent puts in flows and
// metrics), and a few more.
func TestAgentWorkload(t *testing.T) {
	hash := map[string]string{"pod-template-hash": "7bc956576c"}
	for _, c := range []struct {
		name string
		pod  *corev1.Pod
		want *netflows.Workload
	}{
		{"a Deployment's pod", ownedPod("client-7bc956576c-2j5zw", "client-7bc956576c-", "ReplicaSet", "client-7bc956576c", hash), &netflows.Workload{Kind: "Deployment", Name: "client"}},
		{"a bare ReplicaSet's pod", ownedPod("rs-x", "rs-", "ReplicaSet", "rs", nil), &netflows.Workload{Kind: "ReplicaSet", Name: "rs"}},
		{"a ReplicaSet named otherwise than its hash", ownedPod("rs-x", "rs-", "ReplicaSet", "rs", hash), &netflows.Workload{Kind: "ReplicaSet", Name: "rs"}},
		{"a CronJob's Job", ownedPod("backup-29374560-abcde", "backup-29374560-", "Job", "backup-29374560", nil), &netflows.Workload{Kind: "CronJob", Name: "backup"}},
		{"a CronJob's Job, ten digits", ownedPod("sec-1234567890-x", "sec-1234567890-", "Job", "sec-1234567890", nil), &netflows.Workload{Kind: "CronJob", Name: "sec"}},
		{"a Job of its own", ownedPod("migrate-abcde", "migrate-", "Job", "migrate", nil), &netflows.Workload{Kind: "Job", Name: "migrate"}},
		{"a Job with a short number", ownedPod("j-1234567-x", "j-1234567-", "Job", "j-1234567", nil), &netflows.Workload{Kind: "Job", Name: "j-1234567"}},
		{"a StatefulSet's pod", ownedPod("db-0", "db-", "StatefulSet", "db", nil), &netflows.Workload{Kind: "StatefulSet", Name: "db"}},
		{"a DaemonSet's pod", ownedPod("agent-x", "agent-", "DaemonSet", "agent", nil), &netflows.Workload{Kind: "DaemonSet", Name: "agent"}},
		{"an OpenShift DeploymentConfig's pod", ownedPod("app-1-x", "app-1-", "ReplicationController", "app-1", map[string]string{"deploymentconfig": "app"}), &netflows.Workload{Kind: "DeploymentConfig", Name: "app"}},
		{"a ReplicationController's pod", ownedPod("dep-rc-x", "dep-rc-", "ReplicationController", "dep-rc", nil), &netflows.Workload{Kind: "ReplicationController", Name: "dep-rc"}},
		{"a pod named by hand", ownedPod("debug", "", "ReplicaSet", "rs", nil), nil},
		{"a generated pod without a controller", ownedPod("x-1", "x-", "", "", nil), nil},
	} {
		w, ok := agentWorkload(c.pod)
		if ok != (c.want != nil) || ok && w != *c.want {
			t.Errorf("%s: %+v %v", c.name, w, ok)
		}
	}
}

func TestNetflowsLookupLists(t *testing.T) {
	hash := map[string]string{"pod-template-hash": "7bc956576c"}
	cs := fake.NewClientset(
		ownedPod("client-7bc956576c-2j5zw", "client-7bc956576c-", "ReplicaSet", "client-7bc956576c", hash),
		ownedPod("debug", "", "", "", nil),
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"}, Spec: corev1.ServiceSpec{ClusterIP: "10.96.0.20", ClusterIPs: []string{"10.96.0.20", "fd00::20"}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "shop"}, Spec: corev1.ServiceSpec{ClusterIP: corev1.ClusterIPNone, ClusterIPs: []string{corev1.ClusterIPNone}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "ext", Namespace: "shop"}, Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeExternalName}},
	)
	pods, err := netflowsWorkloads(context.Background(), cs, "shop")
	if err != nil || !reflect.DeepEqual(pods, map[string]netflows.Workload{"client-7bc956576c-2j5zw": {Kind: "Deployment", Name: "client"}}) {
		t.Fatalf("pods %v %v", pods, err)
	}
	ips, err := netflowsServiceIPs(context.Background(), cs, "shop")
	if err != nil || !reflect.DeepEqual(ips, map[string]bool{"10.96.0.20": true, "fd00::20": true}) {
		t.Fatalf("service IPs %v %v", ips, err)
	}
	cs.PrependReactor("list", "*", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("forbidden")
	})
	if _, err := netflowsWorkloads(context.Background(), cs, "shop"); err == nil {
		t.Fatal("a refused list is an error")
	}
	if _, err := netflowsServiceIPs(context.Background(), cs, "shop"); err == nil {
		t.Fatal("a refused list is an error")
	}
}
