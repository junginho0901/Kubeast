package k8s

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/podrow"
)

// formatPodList formats a list of pods into map representations.
func formatPodList(pods []corev1.Pod) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(pods))
	for i := range pods {
		result = append(result, formatPodDetail(&pods[i]))
	}
	return result
}

// formatPodDetail is the pod's row (podrow.Info), which the live list updates send too.
func formatPodDetail(p *corev1.Pod) map[string]interface{} {
	return podrow.Info(p)
}

// listOwnedPods returns pods directly owned by the given controller
// (matched via metadata.ownerReferences kind/name). Used by DescribeDaemonSet
// / DescribeReplicaSet / DescribeStatefulSet to embed an owned_pods list in
// the detail response so the UI can show + link to children. The pods are
// listed by the controller's selector a page at a time, as kubectl describe
// does (getPodStatusForController): the whole namespace in one list took
// k8s-service past 512 Mi for one ReplicaSet of a 50 000-pod namespace.
func (s *Service) listOwnedPods(ctx context.Context, namespace, ownerKind, ownerName string, selector *metav1.LabelSelector) ([]map[string]interface{}, error) {
	opts := metav1.ListOptions{}
	if sel, err := metav1.LabelSelectorAsSelector(selector); err == nil && !sel.Empty() {
		opts.LabelSelector = sel.String()
	}
	result := make([]map[string]interface{}, 0)
	err := eachPod(ctx, s.clientsetCtx(ctx).CoreV1(), namespace, opts, func(pod *corev1.Pod) {
		owned := false
		for _, ref := range pod.OwnerReferences {
			if ref.Kind == ownerKind && ref.Name == ownerName {
				owned = true
				break
			}
		}
		if !owned {
			return
		}

		status, ready, total, restarts := podListView(pod)
		result = append(result, map[string]interface{}{
			"name":          pod.Name,
			"namespace":     pod.Namespace,
			"status":        status,
			"ready":         fmt.Sprintf("%d/%d", ready, total),
			"restart_count": restarts,
			"node_name":     pod.Spec.NodeName,
			"pod_ip":        pod.Status.PodIP,
			"created_at":    toISO(&pod.CreationTimestamp),
		})
	})
	if err != nil {
		return nil, fmt.Errorf("list pods in %s: %w", namespace, err)
	}
	return result, nil
}
