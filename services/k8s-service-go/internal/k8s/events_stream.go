package k8s

import (
	"context"
	"fmt"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// eventPageSize: the events read per request. The API server has no order by time, so the newest events of a
// namespace or the cluster are found by reading all of them; 500 at a time holds one page, not the whole list (a
// cluster of 50 000 pods had 107 000 events, which took k8s-service past 512 Mi as one list).
const eventPageSize = 500

// eachEvent calls fn for every event of namespace ("" for all, each of a limited grant's namespaces in turn) that opts
// selects, a page at a time as the caller (eachEventPage).
func (s *Service) eachEvent(ctx context.Context, namespace string, opts metav1.ListOptions, fn func(*corev1.Event)) error {
	return eachCallerNamespace(ctx, namespace, func(ns string) error {
		return eachEventPage(ctx, s.clientsetCtx(ctx), ns, opts, fn)
	})
}

// eachEventPage calls fn for every event of namespace that opts selects, read as client eventPageSize at a time through
// eachPage: a read past its first page takes one of bigReadSlots and waits holding where to go on, not the page it read.
// A later page's expired continue token is an error, never one full list.
func eachEventPage(ctx context.Context, client kubernetes.Interface, namespace string, opts metav1.ListOptions, fn func(*corev1.Event)) error {
	opts.Limit = eventPageSize
	return eachPage(ctx, opts, func(o metav1.ListOptions) (*corev1.EventList, error) {
		return client.CoreV1().Events(namespace).List(ctx, o)
	}, func(l *corev1.EventList) {
		for i := range l.Items {
			fn(&l.Items[i])
		}
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
// cutoff (no cutoff when zero), counting every one in the window. With eventType (Normal, Warning) only that type is
// kept, so a list of warnings is the newest warnings, not the warnings among the newest events. Each namespace's events
// are one read for everyone asking the same at that moment whose identity may list them all (eventWindowFor), else
// the caller's own.
func (s *Service) newestEventsSince(ctx context.Context, namespace string, opts metav1.ListOptions, cutoff time.Time, limit int, eventType string) ([]corev1.Event, eventCounts, error) {
	events, counts, _, err := s.newestEventsRead(ctx, namespace, opts, cutoff, limit, eventType)
	return events, counts, err
}

// newestEventsRead is newestEventsSince that also gives the read for everyone whose newest its events are, when they
// are (one namespace, or the cluster, read so): they are that read's own, for the caller to read, not to change, since
// a crowd woken by one read answers at once.
func (s *Service) newestEventsRead(ctx context.Context, namespace string, opts metav1.ListOptions, cutoff time.Time, limit int, eventType string) ([]corev1.Event, eventCounts, *eventWindow, error) {
	keep := newestEvents{limit: limit}
	var counts eventCounts
	var from *eventWindow
	var fromEvents []corev1.Event
	one := namespace != "" || len(scopeFromCtx(ctx)) == 0
	err := eachCallerNamespace(ctx, namespace, func(ns string) error {
		w, shared, err := s.eventWindowFor(ctx, ns, opts, limit, eventType)
		if err != nil {
			return err
		}
		if shared {
			newest, c := w.since(cutoff)
			counts.Total += c.Total
			counts.Warning += c.Warning
			if one {
				from, fromEvents = w, newest
				return nil
			}
			for i := range newest {
				keep.add(&newest[i])
			}
			return nil
		}
		return eachEventPage(ctx, s.clientsetCtx(ctx), ns, opts, func(e *corev1.Event) {
			if !cutoff.IsZero() && eventTimestamp(*e).Before(cutoff) {
				return
			}
			counts.Total++
			if e.Type == corev1.EventTypeWarning {
				counts.Warning++
			}
			if eventType == "" || e.Type == eventType {
				keep.add(e)
			}
		})
	})
	if err != nil {
		return nil, eventCounts{}, nil, err
	}
	if from != nil {
		return fromEvents, counts, from, nil
	}
	return keep.newest(), counts, nil, nil
}

// eventWindow is one read of the events of a namespace (or the cluster) that a selector picks: the newest limit of a
// type, newest first, and when each event was last seen, oldest first, so each caller cuts its own window (since). It
// is read only once made.
type eventWindow struct {
	newest   []corev1.Event
	seen     []int64 // every event's last seen (seenAt)
	warnings []int64 // the Warning events' last seen

	rowsMade sync.Once
	rows     []map[string]interface{}
}

// timelineRows is newest as the Timeline lists it (timelineEventRow), made once for everyone the read answers: 500
// people woken by one read, each making its own copy and 500 rows, held 226 MiB at once, and 79 MiB with these.
func (w *eventWindow) timelineRows() []map[string]interface{} {
	w.rowsMade.Do(func() {
		w.rows = make([]map[string]interface{}, len(w.newest))
		for i := range w.newest {
			w.rows[i] = timelineEventRow(&w.newest[i])
		}
	})
	return w.rows
}

// since is what the caller's own read with cutoff (none when zero) keeps and counts: the newest at or after cutoff, and
// the events and the warnings at or after it. The events are the window's own, cut to their length so an append copies.
func (w *eventWindow) since(cutoff time.Time) ([]corev1.Event, eventCounts) {
	if cutoff.IsZero() {
		return w.newest[:len(w.newest):len(w.newest)], eventCounts{Total: len(w.seen), Warning: len(w.warnings)}
	}
	at := seenAt(cutoff)
	inside := sort.Search(len(w.newest), func(i int) bool { return seenAt(eventTimestamp(w.newest[i])) < at })
	return w.newest[:inside:inside], eventCounts{Total: countFrom(w.seen, at), Warning: countFrom(w.warnings, at)}
}

// countFrom is how many of sorted are at or after at.
func countFrom(sorted []int64, at int64) int {
	i, _ := slices.BinarySearch(sorted, at)
	return len(sorted) - i
}

var earliestSeen, latestSeen = time.Unix(0, math.MinInt64), time.Unix(0, math.MaxInt64)

// seenAt orders times as Before does, as nanoseconds; a time outside what they hold (an unset one) is the first or last.
func seenAt(t time.Time) int64 {
	switch {
	case t.Before(earliestSeen):
		return math.MinInt64
	case t.After(latestSeen):
		return math.MaxInt64
	}
	return t.UnixNano()
}

// readEventWindow reads every event of namespace that opts selects as client, keeping the newest limit of eventType.
func readEventWindow(ctx context.Context, client kubernetes.Interface, namespace string, opts metav1.ListOptions, limit int, eventType string) (*eventWindow, error) {
	w := &eventWindow{}
	keep := newestEvents{limit: limit}
	err := eachEventPage(ctx, client, namespace, opts, func(e *corev1.Event) {
		at := seenAt(eventTimestamp(*e))
		w.seen = append(w.seen, at)
		if e.Type == corev1.EventTypeWarning {
			w.warnings = append(w.warnings, at)
		}
		if eventType == "" || e.Type == eventType {
			keep.add(e)
		}
	})
	if err != nil {
		return nil, err
	}
	slices.Sort(w.seen)
	slices.Sort(w.warnings)
	w.newest = keep.newest()
	return w, nil
}

// eventWindowFor is namespace's events read once as kubeast:cache for everyone asking the same at that moment whose
// identity may list every event there (SelfSubjectAccessReview through mayList, 60 s): what that identity's own list
// gives, whatever the selector. shared false says to read them as the caller: no cache identity, a limit of all, a
// review that refuses, or kubeast:cache refused them within the last minute.
func (s *Service) eventWindowFor(ctx context.Context, namespace string, opts metav1.ListOptions, limit int, eventType string) (*eventWindow, bool, error) {
	b := s.bundleForCtx(ctx)
	if b == nil || b.cacheClient == nil || limit < 1 || eventsRefusedTo(b, namespace) {
		return nil, false, nil
	}
	may, err := s.mayList(ctx, b, "events", namespace)
	if err != nil && !apierrors.IsForbidden(err) {
		return nil, false, fmt.Errorf("events not listed: %w", err)
	}
	if !may {
		return nil, false, nil
	}
	w, err := s.sharedEventWindow(ctx, b, namespace, opts, limit, eventType)
	if apierrors.IsForbidden(err) {
		b.eventsRefused.Store(namespace, time.Now().Add(accessCheckTTL()))
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return w, true, nil
}

// sharedEventWindow is readEventWindow as kubeast:cache, one at a time per namespace, selector, type and limit for
// everyone waiting (b.eventWindows): the run that answers a caller started after it asked.
func (s *Service) sharedEventWindow(ctx context.Context, b *clientBundle, namespace string, opts metav1.ListOptions, limit int, eventType string) (*eventWindow, error) {
	key := strings.Join([]string{namespace, opts.FieldSelector, opts.LabelSelector, eventType, strconv.Itoa(limit)}, "\x00")
	w, _, err := b.eventWindows.Do(ctx, key, func(ctx context.Context) (*eventWindow, error) {
		// none of the caller's values but the record of its calls: kubeast:cache's own identity
		plain, cancel := context.WithCancel(carryClusterCalls(context.Background(), ctx))
		defer context.AfterFunc(ctx, cancel)()
		defer cancel()
		return readEventWindow(plain, b.cacheClient, namespace, opts, limit, eventType)
	})
	if err != nil {
		// a caller that left while waiting gets its context's error, which says nothing of the events
		if ctxErr := ctx.Err(); ctxErr != nil && err == ctxErr {
			return nil, fmt.Errorf("events not listed: %w", err)
		}
		return nil, err
	}
	where := "the cluster"
	if namespace != "" {
		where = "namespace " + namespace
	}
	accesstrail.Cached(ctx, "events of "+where+" (read as "+overviewCacheUser+")")
	return w, nil
}
