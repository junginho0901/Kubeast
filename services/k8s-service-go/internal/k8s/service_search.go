package k8s

import (
	"context"
	"log/slog"
	"runtime/debug"

	"golang.org/x/sync/singleflight"
)

// searchKey marks the context of a search (searchOnce): its reads of the cluster are not held with the other reads of
// the request that started it (readWait).
type searchKey struct{}

func searching(ctx context.Context) bool { return ctx.Value(searchKey{}) != nil }

// searchOnce runs look, a search of a cluster for a Service (Prometheus, OpenCost), once for everyone who asks meanwhile
// and waits for its end as long as ctx lets. look runs for discoveryTime on the values of the caller who started it: the
// person its requests go as where no cache identity is set up (discoveryClient), the cluster, the record of its calls.
// Not on that caller's time: a search no caller can cut always ends in an answer to remember, and a caller in line for
// one leaves when its own time ends. What one person's search found is for everyone, as what is remembered is.
func searchOnce(ctx context.Context, group *singleflight.Group, look func(ctx context.Context)) {
	limit := discoveryTime
	done := group.DoChan("", func() (interface{}, error) {
		run, cancel := context.WithTimeout(context.WithValue(context.WithoutCancel(ctx), searchKey{}, true), limit)
		defer cancel()
		defer func() {
			if r := recover(); r != nil { // nothing above this goroutine recovers it
				slog.Error("service search panicked", "panic", r, "stack", string(debug.Stack()))
			}
		}()
		look(run)
		return nil, nil
	})
	select {
	case <-done:
	case <-ctx.Done():
	}
}
