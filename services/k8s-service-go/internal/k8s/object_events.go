package k8s

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strconv"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// defaultEventLists: priority and fairness counts a list of many events as 10 seats and a default API server's global-default level has about 49, so four leave the rest to others.
const defaultEventLists = 4

// eventListPlaces bound the lists of one object's events on each cluster at once (EVENT_LIST_CONCURRENCY); the others wait their turn.
var eventListPlaces = newClusterPlaces("event list", eventListConcurrency())

func eventListConcurrency() int {
	if n, err := strconv.Atoi(os.Getenv("EVENT_LIST_CONCURRENCY")); err == nil && n > 0 {
		return n
	}
	return defaultEventLists
}

// objectEvents lists the events about an object as kubectl describe finds them (name and kind, namespace "" when cluster-scoped): one read as kubeast:cache for everyone whose identity may list events there, else as the caller, in its turn.
func (s *Service) objectEvents(ctx context.Context, namespace, kind, name string) (*corev1.EventList, error) {
	b := s.bundleForCtx(ctx)
	if b == nil || b.clientset == nil {
		return nil, errNotLoaded
	}
	selector := fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=%s", name, kind)
	if b.cacheClient != nil && !eventsRefusedTo(b, namespace) {
		ok, err := s.mayList(ctx, b, "events", namespace)
		if err != nil && !apierrors.IsForbidden(err) {
			return nil, fmt.Errorf("events not listed: %w", err)
		}
		if ok {
			list, err := s.sharedObjectEvents(ctx, b, namespace, selector)
			if !apierrors.IsForbidden(err) {
				return list, err
			}
			b.eventsRefused.Store(namespace, time.Now().Add(accessCheckTTL()))
		}
	}
	release, err := eventListPlaces.take(ctx, b.id)
	if err != nil {
		return nil, fmt.Errorf("events not listed: %w", err)
	}
	defer release()
	return b.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{FieldSelector: selector})
}

// eventsRefusedTo says whether kubeast:cache was refused namespace's events within the last minute.
func eventsRefusedTo(b *clientBundle, namespace string) bool {
	until, ok := b.eventsRefused.Load(namespace)
	return ok && time.Now().Before(until.(time.Time))
}

// sharedObjectEvents is one list of the events selector picks as kubeast:cache for everyone asking at that moment, in its turn; each caller sorts its own copy.
func (s *Service) sharedObjectEvents(ctx context.Context, b *clientBundle, namespace, selector string) (*corev1.EventList, error) {
	list, _, err := b.events.Do(ctx, namespace+"\x00"+selector, func(ctx context.Context) (*corev1.EventList, error) {
		release, err := eventListPlaces.take(ctx, b.id)
		if err != nil {
			return nil, fmt.Errorf("events not listed: %w", err)
		}
		defer release()
		return readEvents(ctx, b.cacheClient, namespace, selector)
	})
	if err != nil {
		// a caller that left while waiting gets its context's error, which says nothing of the events
		if ctxErr := ctx.Err(); ctxErr != nil && err == ctxErr {
			return nil, fmt.Errorf("events not listed: %w", err)
		}
		return nil, err
	}
	accesstrail.Cached(ctx, "events of the object (read as "+overviewCacheUser+")")
	own := *list
	own.Items = slices.Clone(list.Items)
	return &own, nil
}

// readEvents lists the events selector picks in namespace as client, with none of the caller's values: client's own identity.
func readEvents(ctx context.Context, client kubernetes.Interface, namespace, selector string) (*corev1.EventList, error) {
	plain, cancel := context.WithCancel(context.Background())
	defer context.AfterFunc(ctx, cancel)()
	defer cancel()
	return client.CoreV1().Events(namespace).List(plain, metav1.ListOptions{FieldSelector: selector})
}
