package k8s

import (
	"context"
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	listpager "k8s.io/client-go/tools/pager"
)

// eventPageSize: the events read per request. The API server has no order by time, so the newest events of a
// namespace or the cluster are found by reading all of them; 500 at a time holds one page, not the whole list (a
// cluster of 50 000 pods had 107 000 events, which took k8s-service past 512 Mi as one list).
const eventPageSize = 500

// eachEvent calls fn for every event of namespace ("" for all) that opts selects, a page at a time. A later page's
// expired continue token is an error: EachListItem does not fall back to one full list (ListPager.List would, by
// default — FullListIfExpired is off here as well).
func (s *Service) eachEvent(ctx context.Context, namespace string, opts metav1.ListOptions, fn func(*corev1.Event)) error {
	p := listpager.New(listpager.SimplePageFunc(func(o metav1.ListOptions) (runtime.Object, error) {
		return s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, o)
	}))
	p.PageSize = eventPageSize
	p.PageBufferSize = 1
	p.FullListIfExpired = false
	return p.EachListItem(ctx, opts, func(obj runtime.Object) error {
		if e, ok := obj.(*corev1.Event); ok {
			fn(e)
		}
		return nil
	})
}

// newestEvents keeps the newest limit events it is given (all of them when limit is 0 or less), holding at most twice
// that between cuts.
type newestEvents struct {
	limit int
	items []corev1.Event
}

func (n *newestEvents) add(e *corev1.Event) {
	n.items = append(n.items, *e)
	if n.limit > 0 && len(n.items) >= 2*n.limit {
		n.cut()
	}
}

// cut sorts newest first and keeps limit.
func (n *newestEvents) cut() {
	sort.SliceStable(n.items, func(i, j int) bool { return eventTimestamp(n.items[i]).After(eventTimestamp(n.items[j])) })
	if n.limit > 0 && len(n.items) > n.limit {
		clear(n.items[n.limit:])
		n.items = n.items[:n.limit]
	}
}

// newest returns the kept events, newest first.
func (n *newestEvents) newest() []corev1.Event {
	n.cut()
	return n.items
}

// eventCounts are what a read saw in the window, beyond the events it kept.
type eventCounts struct {
	Total, Warning int
}

// newestEventsSince reads the events of namespace that opts selects and keeps the newest limit with a time at or after
// cutoff (no cutoff when zero), counting every one in the window.
func (s *Service) newestEventsSince(ctx context.Context, namespace string, opts metav1.ListOptions, cutoff time.Time, limit int) ([]corev1.Event, eventCounts, error) {
	keep := newestEvents{limit: limit}
	var counts eventCounts
	err := s.eachEvent(ctx, namespace, opts, func(e *corev1.Event) {
		if !cutoff.IsZero() && eventTimestamp(*e).Before(cutoff) {
			return
		}
		counts.Total++
		if e.Type == corev1.EventTypeWarning {
			counts.Warning++
		}
		keep.add(e)
	})
	if err != nil {
		return nil, eventCounts{}, err
	}
	return keep.newest(), counts, nil
}
