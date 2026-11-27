package k8s

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
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

// refusedNamespaces are the namespaces of a limited grant that a read across them left out because the cluster refused
// them, in the grant's order, for an answer that says so (noteRefusedNamespaces).
type refusedNamespaces struct {
	mu    sync.Mutex
	names []string
	why   error // the first one's
}

type refusedNamespacesKey struct{}

// noteRefusedNamespaces is ctx with notes of its own: what the reads made with it leave out is in them.
func noteRefusedNamespaces(ctx context.Context) (context.Context, *refusedNamespaces) {
	notes := &refusedNamespaces{}
	return context.WithValue(ctx, refusedNamespacesKey{}, notes), notes
}

// noteRefusedTo adds a namespace left out to ctx's notes, where it has any.
func noteRefusedTo(ctx context.Context) func(namespace string, why error) {
	notes, ok := ctx.Value(refusedNamespacesKey{}).(*refusedNamespaces)
	if !ok {
		return func(string, error) {}
	}
	return func(namespace string, why error) {
		notes.mu.Lock()
		defer notes.mu.Unlock()
		if notes.why == nil {
			notes.why = why
		}
		notes.names = append(notes.names, namespace)
	}
}

func (n *refusedNamespaces) refused() ([]string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return slices.Clone(n.names), n.why
}

// refusedNamesListed: the most names the text of what was left out lists.
const refusedNamesListed = 5

// notReadIn is what an answer says of the namespaces a read left out: their names and the first one's reason.
func notReadIn(names []string, why string) string {
	listed := strings.Join(names[:min(len(names), refusedNamesListed)], ", ")
	if more := len(names) - refusedNamesListed; more > 0 {
		listed += fmt.Sprintf(" and %d more", more)
	}
	return fmt.Sprintf("not read in %s: %s", listed, why)
}

// listAcrossNamespaces runs list once with "" (every namespace) for an
// unscoped caller, or once per namespace of a scoped caller and merges the
// results in the scope's order. A namespace the cluster refuses or does not
// have is skipped — the grant names it, the cluster is not bound there (yet) —
// so the rest still shows, and the refused ones are in ctx's notes for an
// answer that names them (noteRefusedNamespaces); when none could be read and
// one was refused, that refusal is returned (an empty list would read as "the
// cluster has none"). Any other error is returned.
func (s *Service) listAcrossNamespaces(ctx context.Context, list func(namespace string) ([]map[string]interface{}, error)) ([]map[string]interface{}, error) {
	scope := scopeFromCtx(ctx)
	if len(scope) == 0 {
		return list("")
	}
	return fanOutNamespaces(scope, list, noteRefusedTo(ctx))
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
	var left []string
	var why []error
	readOne := false
	for _, ns := range scope {
		if err := read(ns); err != nil {
			if apierrors.IsForbidden(err) {
				refused = err
				left, why = append(left, ns), append(why, err)
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
	note := noteRefusedTo(ctx)
	for i, ns := range left {
		note(ns, why[i])
	}
	return nil
}

// fanOutNamespaces runs list once per namespace of scope, in parallel, and
// merges the results in the scope's order, skipping a namespace the cluster
// refuses or does not have unless none could be read (listAcrossNamespaces).
// left is told each refused one that was skipped, in the scope's order.
func fanOutNamespaces[T any](scope []string, list func(namespace string) ([]T, error), left ...func(namespace string, why error)) ([]T, error) {
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
	for i, items := range results {
		for _, tell := range left {
			if refused[i] != nil {
				tell(scope[i], refused[i])
			}
		}
		out = append(out, items...)
	}
	return out, nil
}
