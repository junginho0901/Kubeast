package cluster

import "context"

type ctxKey struct{}

// WithID returns a context carrying the target cluster ID. Handlers set this
// from the request's ?cluster= parameter; downstream code reads it via
// FromContext to target the right cluster without threading an argument through
// every call.
func WithID(ctx context.Context, id ID) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// FromContext returns the cluster ID carried in ctx, and whether one was set.
// When absent, callers fall back to the registry's default cluster.
func FromContext(ctx context.Context) (ID, bool) {
	id, ok := ctx.Value(ctxKey{}).(ID)
	return id, ok
}
