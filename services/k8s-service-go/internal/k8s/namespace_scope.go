package k8s

import (
	"context"
	"log/slog"
	"slices"
	"sync"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// Namespace-scoped grants (the token's "ns" claim): a user whose grant on the
// request's cluster is limited to namespaces sees only those. The handler
// middleware refuses a namespaced path outside the list; here the
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

// listFanOutWorkers bounds the parallel per-namespace lists of one request.
const listFanOutWorkers = 8

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
	results := make([][]map[string]interface{}, len(scope))
	read := make([]bool, len(scope))
	refused := make([]error, len(scope))
	errs := make([]error, len(scope))
	var wg sync.WaitGroup
	sem := make(chan struct{}, listFanOutWorkers)
	for i, ns := range scope {
		wg.Add(1)
		go func(i int, ns string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
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
		}(i, ns)
	}
	wg.Wait()
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
	out := make([]map[string]interface{}, 0)
	for _, items := range results {
		out = append(out, items...)
	}
	return out, nil
}
