package ws

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

// chanAPI is a cluster whose watches hand over each object only when the multiplexer reads it (an unbuffered
// channel), so what it counts as receiving is what k8s-service is reading at that moment, whatever the network buffers.
type chanAPI struct {
	objects int
	gap     time.Duration
	// stallAt, stall: a pause after that many objects.
	stallAt int
	stall   time.Duration
	// noBookmark leaves the watch list's bookmark out; refuse answers sendInitialEvents with the 422 of a server whose
	// WatchList gate is off; hang never answers a watch; failAfter answers it with a 503 after that long.
	noBookmark bool
	// bookmarkFor still gets its bookmark, the watch whose label selector it is.
	bookmarkFor string
	refuse      bool
	hang        bool
	failAfter   time.Duration
	// also counts this cluster's receiving watches together with another's.
	also *tally

	mu              sync.Mutex
	asked           []metav1.ListOptions
	receiving, most int
}

func (a *chanAPI) watch(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error) {
	a.mu.Lock()
	a.asked = append(a.asked, opts)
	a.mu.Unlock()
	switch {
	case a.hang:
		<-ctx.Done()
		return nil, ctx.Err()
	case a.failAfter > 0:
		select {
		case <-time.After(a.failAfter):
			return nil, apierrors.NewServiceUnavailable("the server is currently unable to handle the request")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	case a.refuse && opts.SendInitialEvents != nil:
		return nil, apierrors.NewInvalid(schema.GroupKind{Group: "meta.k8s.io", Kind: "ListOptions"}, "",
			field.ErrorList{field.Forbidden(field.NewPath("sendInitialEvents"), "sendInitialEvents is forbidden for watch unless the WatchList feature gate is enabled")})
	}
	w := &chanWatcher{ch: make(chan watch.Event), stop: make(chan struct{})}
	go func() {
		defer close(w.ch)
		for i := 0; i < a.objects; i++ {
			if !w.send(ctx, watch.Added, chanPod(i, 10+i, nil)) {
				return
			}
			if i == 0 {
				a.mu.Lock()
				a.receiving++
				a.most = max(a.most, a.receiving)
				a.mu.Unlock()
				a.also.add(1)
			}
			if i+1 == a.objects {
				a.mu.Lock()
				a.receiving--
				a.mu.Unlock()
				a.also.add(-1)
			}
			if a.stall > 0 && i+1 == a.stallAt {
				time.Sleep(a.stall)
			}
			time.Sleep(a.gap)
		}
		if opts.SendInitialEvents != nil && (!a.noBookmark || opts.LabelSelector == a.bookmarkFor) {
			end := chanPod(0, 500, map[string]interface{}{metav1.InitialEventsAnnotationKey: "true"})
			if !w.send(ctx, watch.Bookmark, end) {
				return
			}
		}
		select {
		case <-w.stop:
		case <-ctx.Done():
		}
	}()
	return w, nil
}

func (a *chanAPI) mostAtOnce() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.most
}

func (a *chanAPI) options() []metav1.ListOptions {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]metav1.ListOptions(nil), a.asked...)
}

// tally counts receiving watches of several chanAPIs together.
type tally struct {
	mu        sync.Mutex
	now, most int
}

func (t *tally) add(n int) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.now += n
	t.most = max(t.most, t.now)
}

func (t *tally) mostAtOnce() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.most
}

func chanPod(i, rv int, annotations map[string]interface{}) *unstructured.Unstructured {
	meta := map[string]interface{}{"name": fmt.Sprintf("web-%d", i), "namespace": "demo", "resourceVersion": fmt.Sprint(rv)}
	if annotations != nil {
		meta["annotations"] = annotations
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "Pod", "metadata": meta,
		"spec": map[string]interface{}{"containers": []interface{}{}}, "status": map[string]interface{}{"phase": "Running"},
	}}
}

type chanWatcher struct {
	ch   chan watch.Event
	stop chan struct{}
	once sync.Once
}

func (w *chanWatcher) send(ctx context.Context, t watch.EventType, obj *unstructured.Unstructured) bool {
	select {
	case w.ch <- watch.Event{Type: t, Object: obj}:
		return true
	case <-w.stop:
	case <-ctx.Done():
	}
	return false
}

func (w *chanWatcher) Stop()                          { w.once.Do(func() { close(w.stop) }) }
func (w *chanWatcher) ResultChan() <-chan watch.Event { return w.ch }

// chanClusters gives each cluster's watches to its chanAPI, by the cluster in the watch's context.
type chanClusters map[string]*chanAPI

func (p chanClusters) Clientset() *kubernetes.Clientset { return nil }
func (p chanClusters) Dynamic() dynamic.Interface       { return nil }
func (p chanClusters) DynamicForCtx(ctx context.Context) dynamic.Interface {
	id, _ := cluster.FromContext(ctx)
	if api, ok := p[string(id)]; ok {
		return chanDynamic{api: api}
	}
	return chanDynamic{api: p[string(cluster.Default)]}
}

type chanDynamic struct {
	dynamic.Interface
	api *chanAPI
}

func (d chanDynamic) Resource(schema.GroupVersionResource) dynamic.NamespaceableResourceInterface {
	return chanResource{api: d.api}
}

type chanResource struct {
	dynamic.NamespaceableResourceInterface
	api *chanAPI
}

func (r chanResource) Namespace(string) dynamic.ResourceInterface { return r }
func (r chanResource) Watch(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error) {
	return r.api.watch(ctx, opts)
}

// chanWatch runs a watch of cluster id as the socket does, the cluster in its context.
func chanWatch(ctx context.Context, m *Multiplexer, id, query string, out chan<- *ResponseMessage) {
	m.runWatch(cluster.WithID(ctx, cluster.ID(id)), RequestMessage{ClusterID: id, Path: "/api/v1/pods", Query: query}, out)
}

// crowdOpens starts n watches of cluster id and returns when each had its first frame, the last one's time and how
// many frames said a limit, once all had one or within passed.
func crowdOpens(ctx context.Context, m *Multiplexer, id string, n int, within time.Duration) (opened int, last time.Duration, limits int) {
	var mu sync.Mutex
	start := time.Now()
	for i := 0; i < n; i++ {
		out := make(chan *ResponseMessage, 64)
		go chanWatch(ctx, m, id, fmt.Sprintf("watch=1&labelSelector=a%%3D%d", i), out)
		go func() {
			seen := false
			for {
				select {
				case f := <-out:
					mu.Lock()
					if f.Type == "ERROR" {
						limits++
					}
					if f.Type == "DATA" && !seen {
						seen = true
						opened++
						last = max(last, time.Since(start))
					}
					mu.Unlock()
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := opened >= n
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	return opened, last, limits
}
