package handler

import (
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/response"
)

// notInstalledHeader, on an empty list answer, names the resource the cluster
// does not serve (its CRD is not installed), so the console says "not
// installed" instead of "none" or "no permission".
const notInstalledHeader = "X-Kubeast-Not-Installed"

// ListIfServed answers a list request with an empty list and the
// not-installed header when the request's cluster does not serve
// group/resource; otherwise the list runs as usual. It runs before the list —
// so before the API server's authorization — and every role gets the same
// answer (a Read user used to get 403 and an admin an empty list).
func (h *Handler) ListIfServed(group, resource string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !h.svc.ResourceServed(r.Context(), group, resource) {
				w.Header().Set(notInstalledHeader, resource)
				response.JSON(w, http.StatusOK, []interface{}{})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
