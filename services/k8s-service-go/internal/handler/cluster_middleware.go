package handler

import (
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// ClusterMiddleware reads the ?cluster= query parameter and stores the target
// cluster ID in the request context. Cluster-aware service methods read it via
// the *Ctx accessors. When absent, no cluster is set and the service falls back
// to the registry's default cluster — so existing single-cluster callers keep
// working unchanged.
func ClusterMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c := r.URL.Query().Get("cluster"); c != "" {
			r = r.WithContext(cluster.WithID(r.Context(), cluster.ID(c)))
		}
		next.ServeHTTP(w, r)
	})
}
