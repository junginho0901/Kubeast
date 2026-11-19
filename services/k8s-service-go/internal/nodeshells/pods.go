package nodeshells

import (
	"context"
	"encoding/json"
	"errors"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// PodRemover is the Remover of a server: clients gives the clientset of the
// cluster in ctx, as the person in ctx (k8s-service ClientsetFor).
func PodRemover(clients func(ctx context.Context) (kubernetes.Interface, error)) Remover {
	return func(ctx context.Context, r Row) (bool, error) {
		if r.Cluster != "" {
			ctx = cluster.WithID(ctx, cluster.ID(r.Cluster))
		}
		var p auth.TokenPayload
		if len(r.Person) > 0 && json.Unmarshal(r.Person, &p) == nil {
			ctx = auth.WithPayload(ctx, p)
		}
		cs, err := clients(ctx)
		if errors.Is(err, cluster.ErrNotFound) { // the cluster was removed from Kubeast: nothing left to reach
			return false, nil
		}
		if err != nil {
			return false, err
		}
		pods := cs.CoreV1().Pods(r.Namespace)
		pod, err := pods.Get(ctx, r.Pod, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if pod.Labels[LabelID] != r.ID { // a pod of that name that is not this shell's
			return false, nil
		}
		grace := int64(0)
		bg := metav1.DeletePropagationBackground
		err = pods.Delete(ctx, r.Pod, metav1.DeleteOptions{
			GracePeriodSeconds: &grace,
			PropagationPolicy:  &bg,
			Preconditions:      &metav1.Preconditions{UID: &pod.UID},
		})
		if apierrors.IsNotFound(err) || apierrors.IsConflict(err) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		return true, nil
	}
}
