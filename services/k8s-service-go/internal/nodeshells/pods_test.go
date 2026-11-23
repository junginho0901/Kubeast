package nodeshells

import (
	"context"
	"errors"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func shellPod(name, id string) *corev1.Pod {
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "kubeast-node-shell", UID: types.UID("uid-" + name),
		Labels: map[string]string{"app": "node-debugger", LabelID: id}}}
}

func row(id, pod string) Row {
	return Row{ID: id, Cluster: "c2", Namespace: "kubeast-node-shell", Pod: pod, Node: "n1",
		Person: PersonFor(auth.TokenPayload{UserID: "u1", Email: "ops@example.com", Perms: auth.PermissionMatrix{"c2": {"resource.node.shell"}}}, "c2")}
}

func podNames(t *testing.T, cs kubernetes.Interface) map[string]bool {
	t.Helper()
	list, err := cs.CoreV1().Pods("kubeast-node-shell").List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, p := range list.Items {
		out[p.Name] = true
	}
	return out
}

// The pod the row names, carrying the row's label, is deleted in the row's cluster as the person who opened it; a pod
// of the same name with another shell's label, and every other pod, stay.
func TestThePodRemoverDeletesOnlyTheRowsPodAsItsOpener(t *testing.T) {
	cs := fake.NewSimpleClientset(shellPod("node-debugger-n1-aaaaa", "s1"), shellPod("node-debugger-n1-bbbbb", "s2"), shellPod("node-debugger-n1-ccccc", "other"))
	var asked []string
	remove := PodRemover(func(ctx context.Context) (kubernetes.Interface, error) {
		id, _ := cluster.FromContext(ctx)
		p, _ := auth.FromContext(ctx)
		asked = append(asked, string(id)+" "+p.Email)
		return cs, nil
	})

	deleted, err := remove(context.Background(), row("s1", "node-debugger-n1-aaaaa"))
	if err != nil || !deleted {
		t.Fatalf("remove s1 = %v %v, want deleted", deleted, err)
	}
	deleted, err = remove(context.Background(), row("s3", "node-debugger-n1-ccccc"))
	if err != nil || deleted {
		t.Fatalf("remove of a pod with another shell's label = %v %v, want left", deleted, err)
	}
	deleted, err = remove(context.Background(), row("s4", "node-debugger-n1-gone"))
	if err != nil || deleted {
		t.Fatalf("remove of a pod already gone = %v %v, want (false, nil)", deleted, err)
	}

	got := podNames(t, cs)
	if got["node-debugger-n1-aaaaa"] || !got["node-debugger-n1-bbbbb"] || !got["node-debugger-n1-ccccc"] {
		t.Fatalf("pods left %v", got)
	}
	for _, a := range asked {
		if a != "c2 ops@example.com" {
			t.Fatalf("clients asked for %q, want the row's cluster and its opener", a)
		}
	}
}

// A cluster that cannot be reached is an error (the row waits for a later sweep); a cluster removed from Kubeast is
// nothing left to delete.
func TestThePodRemoverOnClustersItCannotReach(t *testing.T) {
	refused := errors.New("dial tcp 10.0.0.1:6443: connect: connection refused")
	remove := PodRemover(func(context.Context) (kubernetes.Interface, error) { return nil, refused })
	if deleted, err := remove(context.Background(), row("s1", "p")); !errors.Is(err, refused) || deleted {
		t.Fatalf("unreachable cluster = %v %v, want its error", deleted, err)
	}
	remove = PodRemover(func(context.Context) (kubernetes.Interface, error) { return nil, cluster.ErrNotFound })
	if deleted, err := remove(context.Background(), row("s1", "p")); err != nil || deleted {
		t.Fatalf("removed cluster = %v %v, want (false, nil)", deleted, err)
	}
}

// The opener's binding removed: the cluster refuses the read as forbidden, which is an error (the row waits, until
// its deadline). A pod replaced under the same name between the read and the delete fails the UID precondition with
// 409: nothing of this row to delete.
func TestThePodRemoverOnARefusalAndAReplacedPod(t *testing.T) {
	podsGR := schema.GroupResource{Resource: "pods"}
	refusing := fake.NewSimpleClientset(shellPod("node-debugger-n1-aaaaa", "s1"))
	refusing.PrependReactor("get", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(podsGR, "node-debugger-n1-aaaaa", errors.New("binding removed"))
	})
	remove := PodRemover(func(context.Context) (kubernetes.Interface, error) { return refusing, nil })
	if deleted, err := remove(context.Background(), row("s1", "node-debugger-n1-aaaaa")); !apierrors.IsForbidden(err) || deleted {
		t.Fatalf("forbidden read = %v %v, want the refusal as an error", deleted, err)
	}

	replaced := fake.NewSimpleClientset(shellPod("node-debugger-n1-aaaaa", "s1"))
	replaced.PrependReactor("delete", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewConflict(podsGR, "node-debugger-n1-aaaaa", errors.New("Precondition failed: UID in precondition: uid-node-debugger-n1-aaaaa, UID in object meta: other"))
	})
	remove = PodRemover(func(context.Context) (kubernetes.Interface, error) { return replaced, nil })
	if deleted, err := remove(context.Background(), row("s1", "node-debugger-n1-aaaaa")); err != nil || deleted {
		t.Fatalf("a replaced pod = %v %v, want (false, nil)", deleted, err)
	}
	if !podNames(t, replaced)["node-debugger-n1-aaaaa"] {
		t.Fatal("the pod that replaced it is gone")
	}
}
