package handler

import (
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
)

// routeAct is what a route does in the namespace it names, for the rule in services/pkg/protectedns. Log files count as
// a terminal because they are read through pods/exec. TestRoutesSayWhatTheyDo holds the routes to this.
func routeAct(method, pattern string) protectedns.Act {
	switch {
	case method != http.MethodGet:
		return protectedns.ActWrite
	case strings.HasSuffix(pattern, "/exec/ws"), strings.Contains(pattern, "/logfiles"):
		return protectedns.ActExec
	case strings.Contains(pattern, "/secrets"), strings.HasPrefix(pattern, "/api/v1/helm/releases"):
		return protectedns.ActSecretRead
	case strings.HasSuffix(pattern, "/logs"), strings.HasSuffix(pattern, "/logs/stream"), strings.Contains(pattern, "/logsearch"):
		return protectedns.ActLog
	}
	return protectedns.ActRead
}

// protectedAct is routeAct, and for the routes that take any kind by name what the kind says.
func (h *Handler) protectedAct(r *http.Request, pattern string) protectedns.Act {
	act := routeAct(r.Method, pattern)
	if act == protectedns.ActRead && strings.HasPrefix(pattern, "/api/v1/resources") && h.isSecretResourceType(r, queryParam(r, "resource_type", "")) {
		return protectedns.ActSecretRead
	}
	return act
}

// protectedRefusal applies the guarded namespaces to the namespaces a request reaches, with what refusal says for a refused row.
func (a scopeAsk) protectedRefusal(protected protectedns.Namespaces, payload auth.TokenPayload, clusterID string, act protectedns.Act) (string, string, error) {
	for _, ns := range a.namespaces {
		if err := protected.Refusal(payload, clusterID, ns, act); err != nil {
			return "namespace", ns, err
		}
	}
	return "", "", nil
}
