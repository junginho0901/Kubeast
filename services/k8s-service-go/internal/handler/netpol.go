package handler

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// EffectiveNetworkPolicies handles
// GET /api/v1/namespaces/{namespace}/networkpolicies/effective?kind=Pod&name=web-1:
// the NetworkPolicies that select a pod, or a workload's pods, per direction.
func (h *Handler) EffectiveNetworkPolicies(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.networkpolicy.read"); err != nil {
		h.handleError(w, err)
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		response.Error(w, http.StatusBadRequest, "name is required")
		return
	}
	data, err := h.svc.EffectiveNetworkPolicies(r.Context(), chi.URLParam(r, "namespace"), queryParam(r, "kind", "Pod"), name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// CheckNetworkPolicy handles GET /api/v1/networkpolicies/check?src=&dst=&port=&protocol=:
// whether NetworkPolicy allows src to reach dst. An end is <kind>/<namespace>/<name>
// (dst may be a service) or an IP address; both namespaces must be in the user's grant.
func (h *Handler) CheckNetworkPolicy(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.networkpolicy.read"); err != nil {
		h.handleError(w, err)
		return
	}
	q := r.URL.Query()
	src, err := k8s.ParseNetpolRef(q.Get("src"), false)
	if err != nil {
		h.handleError(w, err)
		return
	}
	dst, err := k8s.ParseNetpolRef(q.Get("dst"), true)
	if err != nil {
		h.handleError(w, err)
		return
	}
	if err := h.netpolNamespacesAllowed(r, src, dst); err != nil {
		response.Error(w, http.StatusForbidden, err.Error())
		return
	}
	protocol := corev1.Protocol(strings.ToUpper(strings.TrimSpace(q.Get("protocol"))))
	switch protocol {
	case "", corev1.ProtocolTCP, corev1.ProtocolUDP, corev1.ProtocolSCTP:
	default:
		response.Error(w, http.StatusBadRequest, "protocol must be TCP, UDP or SCTP")
		return
	}
	data, err := h.svc.CheckNetworkPolicy(r.Context(), src, dst, q.Get("port"), protocol)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// netpolNamespacesAllowed applies a namespace-scoped grant to both ends, as
// NamespaceScopeMiddleware does for a namespaced path.
func (h *Handler) netpolNamespacesAllowed(r *http.Request, refs ...k8s.NetpolRef) error {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		return nil
	}
	id, _ := cluster.FromContext(r.Context())
	for _, ref := range refs {
		if ref.Namespace != "" && !payload.AllowedIn(string(id), ref.Namespace) {
			return errors.New("forbidden: namespace " + ref.Namespace + " is outside your grant on cluster " + string(id))
		}
	}
	return nil
}
