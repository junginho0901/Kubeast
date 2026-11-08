package k8s

import (
	"context"
	"os"
	"strconv"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	corev1client "k8s.io/client-go/kubernetes/typed/core/v1"

	"github.com/junginho0901/kubeast/services/pkg/limits"
)

// defaultBigReads: one read of a 50 000-pod namespace asked 39 to 78 pages a second of the client's 100 and held up to
// about 110 MiB, so two stay inside the GC's 461 MiB with the 90 MiB k8s-service holds anyway; three come near it.
const defaultBigReads = 2

// bigReadSlots bounds the reads of more than one page at once (BIG_READ_CONCURRENCY); the others wait their turn. It
// is taken before a read's second page, so what fits one page waits for no one. A holder only lists and folds pages, so
// it never waits for anything else that waits for it.
var bigReadSlots = limits.NewSlots("big read", bigReadConcurrency())

func bigReadConcurrency() int {
	if n, err := strconv.Atoi(os.Getenv("BIG_READ_CONCURRENCY")); err == nil && n > 0 {
		return n
	}
	return defaultBigReads
}

// pagedRead is one read's place among bigReadSlots; a reader defers done.
type pagedRead struct{ release func() }

// nextPage waits for the read's place, which it keeps until done.
func (r *pagedRead) nextPage(ctx context.Context) error {
	if r.release != nil {
		return nil
	}
	release, err := bigReadSlots.Take(ctx)
	if err != nil {
		return err
	}
	r.release = release
	return nil
}

func (r *pagedRead) done() {
	if r.release != nil {
		r.release()
		r.release = nil
	}
}

// eachPod calls fn for every pod of namespace ("" for all) that opts selects, podListChunk at a time, as the
// client's identity: a caller keeps what it needs from each page instead of the whole list. A namespace of 50 000
// pods as one list took k8s-service past its 512 Mi from one request (the GPU dashboard, the Namespace and ReplicaSet
// drawers). An expired continue token on a later page is an error, as in eachEvent.
func eachPod(ctx context.Context, pods corev1client.PodsGetter, namespace string, opts metav1.ListOptions, fn func(*corev1.Pod)) error {
	var read pagedRead
	defer read.done()
	if opts.Limit == 0 {
		opts.Limit = podListChunk
	}
	for {
		l, err := pods.Pods(namespace).List(ctx, opts)
		if err != nil {
			return err
		}
		for i := range l.Items {
			fn(&l.Items[i])
		}
		if l.Continue == "" {
			return nil
		}
		if err := read.nextPage(ctx); err != nil {
			return err
		}
		opts.Continue = l.Continue
		opts.ResourceVersion, opts.ResourceVersionMatch = "", ""
	}
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
