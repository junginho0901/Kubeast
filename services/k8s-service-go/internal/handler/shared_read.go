package handler

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"slices"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/flight"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// sharedAnswer is a response as one run of a handler wrote it, which a client waiting on that run gets byte for byte.
type sharedAnswer struct {
	header        http.Header
	status        int
	body          bytes.Buffer
	clusterFailed bool
}

func (a *sharedAnswer) Header() http.Header { return a.header }

func (a *sharedAnswer) WriteHeader(status int) {
	if a.status == 0 {
		a.status = status
	}
}

func (a *sharedAnswer) Write(b []byte) (int, error) {
	a.WriteHeader(http.StatusOK)
	return a.body.Write(b)
}

func (a *sharedAnswer) noteClusterFailure() { a.clusterFailed = true }

func (a *sharedAnswer) writeTo(w http.ResponseWriter) {
	for k, v := range a.header {
		w.Header()[k] = slices.Clone(v)
	}
	if failure, ok := w.(clusterFailureNoter); ok && a.clusterFailed {
		failure.noteClusterFailure()
	}
	w.WriteHeader(a.status)
	_, _ = w.Write(a.body.Bytes())
}

// withOwnRoute gives the handler a copy of the route: the router reuses its own once the request that had it has ended,
// which a shared read may outlive.
func withOwnRoute(ctx context.Context) context.Context {
	route := chi.RouteContext(ctx)
	if route == nil {
		return ctx
	}
	own := chi.NewRouteContext()
	own.URLParams.Keys = slices.Clone(route.URLParams.Keys)
	own.URLParams.Values = slices.Clone(route.URLParams.Values)
	own.RoutePatterns = slices.Clone(route.RoutePatterns)
	own.RoutePath, own.RouteMethod = route.RoutePath, route.RouteMethod
	return context.WithValue(ctx, chi.RouteCtxKey, own)
}

// Shared answers a read with the answer of one run of next for everyone asking the same thing at the same moment with
// the same claims, on the same cluster: a crowd on one object costs the cluster about two reads, and the JSON is made
// once for those who waited. Each caller has passed the middleware itself, the answer never crosses to other claims,
// and a run started before a caller asked does not answer it (flight.Group), so the answer is the one that caller would
// have got alone. A caller with no run to wait for goes through next as if this were not here, its answer written
// straight to the client, not held. Only for a read whose handler reads nothing else of the request and writes no audit
// row.
func (h *Handler) Shared(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		payload, ok := auth.FromContext(r.Context())
		claims := payload.ClaimsKey()
		if !ok || claims == "" {
			next(w, r)
			return
		}
		id, _ := cluster.FromContext(r.Context())
		own := r.Clone(withOwnRoute(r.Context()))
		own.Body = http.NoBody
		answer, joined, err := h.sharedReads.DoOr(own.Context(), string(id)+"|"+claims+"|"+r.URL.RequestURI(),
			func() (*sharedAnswer, error) {
				next(w, r)
				return nil, nil
			},
			func(ctx context.Context) (*sharedAnswer, error) {
				a := &sharedAnswer{header: http.Header{}}
				next(a, own.WithContext(ctx))
				a.WriteHeader(http.StatusOK)
				return a, nil
			})
		switch {
		case errors.Is(err, flight.ErrPanicked):
			response.InternalError(w, r, err)
		case err != nil:
			h.handleError(w, err)
		case answer != nil:
			if joined {
				accesstrail.Cached(r.Context(), "the same read of another request")
			}
			answer.writeTo(w)
		}
	}
}
