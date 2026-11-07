package k8s

import (
	"context"
	"fmt"
	"os"
	"strconv"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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

// objectEvents lists the events about an object as kubectl describe finds them (name and kind, namespace "" when cluster-scoped) as the caller, in its turn.
func (s *Service) objectEvents(ctx context.Context, namespace, kind, name string) (*corev1.EventList, error) {
	b := s.bundleForCtx(ctx)
	if b == nil || b.clientset == nil {
		return nil, errNotLoaded
	}
	release, err := eventListPlaces.take(ctx, b.id)
	if err != nil {
		return nil, fmt.Errorf("events not listed: %w", err)
	}
	defer release()
	return b.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=%s", name, kind),
	})
}
