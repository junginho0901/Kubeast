package k8s

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// Namespace-scoped grants (the token's "ns" claim): a user whose grant on the
// request's cluster is limited to namespaces sees only those. The handler
// middleware refuses a namespace outside the list, however a route names it; here the
// all-namespaces reads fan out over the list instead of asking the cluster for
// everything (which the cluster would refuse: the grant's group is bound per
// namespace), and the namespace list and overview are built from it.

// scopeFromCtx returns the caller's namespace scope on the ctx cluster, or
// nil when the grant is not namespace-scoped (or there is no caller).
func scopeFromCtx(ctx context.Context) []string {
	p, ok := auth.FromContext(ctx)
	if !ok {
		return nil
	}
	return p.Namespaces[string(ctxClusterID(ctx))]
}

// CallerScope is scopeFromCtx for the packages beside this one.
func CallerScope(ctx context.Context) []string { return scopeFromCtx(ctx) }

// inCallerScope reports whether the caller's grant on the ctx cluster reaches namespace.
func inCallerScope(ctx context.Context, namespace string) bool {
	scope := scopeFromCtx(ctx)
	return len(scope) == 0 || slices.Contains(scope, namespace)
}

// isNamespaceKind reports whether gvr is the Namespace kind, whose objects are named as a grant lists them.
func isNamespaceKind(gvr schema.GroupVersionResource) bool {
	return gvr.Group == "" && gvr.Resource == "namespaces"
}

// listFanOutWorkers bounds the parallel per-namespace lists of one request.
const listFanOutWorkers = 8

// sideBySide runs do(0) … do(n-1) on at most listFanOutWorkers goroutines, each taking the next index when it is free.
func sideBySide(n int, do func(i int)) {
	var next atomic.Int64
	var wg sync.WaitGroup
	for range min(n, listFanOutWorkers) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := int(next.Add(1) - 1); i < n; i = int(next.Add(1) - 1) {
				do(i)
			}
		}()
	}
	wg.Wait()
}

// listAcrossNamespaces runs list once with "" (every namespace) for an
// unscoped caller, or once per namespace of a scoped caller and merges the
// results in the scope's order. A namespace the cluster refuses or does not
// have is skipped — the grant names it, the cluster is not bound there (yet) —
// so the rest still shows; when none could be read and one was refused, that
// refusal is returned (an empty list would read as "the cluster has none").
// Any other error is returned.
func (s *Service) listAcrossNamespaces(ctx context.Context, list func(namespace string) ([]map[string]interface{}, error)) ([]map[string]interface{}, error) {
	scope := scopeFromCtx(ctx)
	if len(scope) == 0 {
		return list("")
	}
	return fanOutNamespaces(scope, list)
}

// FanOutNamespaces is fanOutNamespaces for the packages beside this one.
func FanOutNamespaces[T any](scope []string, list func(namespace string) ([]T, error)) ([]T, error) {
	return fanOutNamespaces(scope, list)
}

// eachCallerNamespace runs read for namespace, or, when every namespace ("") is asked by a caller limited to
// namespaces, for each of those in turn, for a read that adds to one result as it goes. A namespace the cluster refuses
// or does not have is skipped unless none could be read, as listAcrossNamespaces does.
func eachCallerNamespace(ctx context.Context, namespace string, read func(namespace string) error) error {
	scope := scopeFromCtx(ctx)
	if namespace != "" || len(scope) == 0 {
		return read(namespace)
	}
	var refused error
	readOne := false
	for _, ns := range scope {
		if err := read(ns); err != nil {
			if apierrors.IsForbidden(err) {
				refused = err
				continue
			}
			if apierrors.IsNotFound(err) {
				continue
			}
			return err
		}
		readOne = true
	}
	if !readOne {
		return refused
	}
	return nil
}

// fanOutNamespaces runs list once per namespace of scope, in parallel, and
// merges the results in the scope's order, skipping a namespace the cluster
// refuses or does not have unless none could be read (listAcrossNamespaces).
func fanOutNamespaces[T any](scope []string, list func(namespace string) ([]T, error)) ([]T, error) {
	results := make([][]T, len(scope))
	read := make([]bool, len(scope))
	refused := make([]error, len(scope))
	errs := make([]error, len(scope))
	sideBySide(len(scope), func(i int) {
		ns := scope[i]
		items, err := list(ns)
		if err != nil {
			if apierrors.IsForbidden(err) || apierrors.IsNotFound(err) {
				slog.Debug("namespace scope: skipping namespace the cluster refused", "namespace", ns, "err", err)
				if apierrors.IsForbidden(err) {
					refused[i] = err
				}
				return
			}
			errs[i] = err
			return
		}
		results[i] = items
		read[i] = true
	})
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	if !slices.Contains(read, true) {
		for _, err := range refused {
			if err != nil {
				return nil, err
			}
		}
	}
	out := make([]T, 0)
	for _, items := range results {
		out = append(out, items...)
	}
	return out, nil
}
