package k8s

import (
	"context"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	corev1client "k8s.io/client-go/kubernetes/typed/core/v1"
	listpager "k8s.io/client-go/tools/pager"
)

// eachPod calls fn for every pod of namespace ("" for all) that opts selects, podListChunk at a time, as the
// client's identity: a caller keeps what it needs from each page instead of the whole list. A namespace of 50 000
// pods as one list took k8s-service past its 512 Mi from one request (the GPU dashboard, the Namespace and ReplicaSet
// drawers). An expired continue token on a later page is an error, as in eachEvent.
func eachPod(ctx context.Context, pods corev1client.PodsGetter, namespace string, opts metav1.ListOptions, fn func(*corev1.Pod)) error {
	p := listpager.New(listpager.SimplePageFunc(func(o metav1.ListOptions) (runtime.Object, error) {
		return pods.Pods(namespace).List(ctx, o)
	}))
	p.PageSize = podListChunk
	p.PageBufferSize = 1
	p.FullListIfExpired = false
	return p.EachListItem(ctx, opts, func(obj runtime.Object) error {
		if pod, ok := obj.(*corev1.Pod); ok {
			fn(pod)
		}
		return nil
	})
}

// countList is how many objects a list holds without reading them: a first page of one item and the API server's
// remainingItemCount, which is exact without a selector. A server that leaves it out is counted podListChunk at a
// time. page lists with the options it is given and returns the items it got and the list's metadata.
func countList(page func(metav1.ListOptions) (int, metav1.ListMeta, error)) (int, error) {
	n, meta, err := page(metav1.ListOptions{Limit: 1})
	if err != nil {
		return 0, err
	}
	if meta.Continue == "" {
		return n, nil
	}
	if meta.RemainingItemCount != nil {
		return n + int(*meta.RemainingItemCount), nil
	}
	for opts := (metav1.ListOptions{Limit: podListChunk, Continue: meta.Continue}); opts.Continue != ""; {
		m, next, err := page(opts)
		if err != nil {
			return 0, err
		}
		n += m
		opts.Continue = next.Continue
	}
	return n, nil
}
