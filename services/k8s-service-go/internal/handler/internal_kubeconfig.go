package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetClusterKubeconfig serves a cluster's kubeconfig to tool-server so it can run
// kubectl against that cluster at runtime (step 14, rollout-free). This is the
// registered kubeconfig (the cluster-kubeconfig-<id> Secret) that k8s-service
// already reads — tool-server just fetches it here instead of holding its own.
//
//	GET /internal/clusters/{id}/kubeconfig → { "kubeconfig": "...", "in_cluster": bool }
//
// Security: internal-only (NOT routed via the gateway) + gated by the caller's
// per-cluster access — a user can only obtain kubeconfigs for clusters they hold
// a grant on (deny-by-default), so it can't widen what they could already do.
// in_cluster=true returns no blob (the cluster uses the in-cluster SA).
func (h *Handler) GetClusterKubeconfig(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	// Access = a global admin (matrix["*"]) or a per-cluster grant on this id.
	if len(payload.Perms["*"]) == 0 && len(payload.Perms[id]) == 0 {
		h.auditKubeconfigRead(r, payload, id, errForbiddenKubeconfig)
		response.Error(w, http.StatusForbidden, "forbidden: no access to cluster "+id)
		return
	}

	blob, inCluster, err := h.svc.ClusterKubeconfig(r.Context(), cluster.ID(id))
	h.auditKubeconfigRead(r, payload, id, err)
	if err != nil {
		h.handleError(w, err)
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"kubeconfig": blob,
		"in_cluster": inCluster,
	})
}

// InvalidateCluster drops a cluster's cached client bundle + derived caches so
// the next request rebuilds from the (just-rotated) kubeconfig — no rollout.
// Internal-only (NOT gateway-routed); auth-service calls this after a kubeconfig
// rotation, forwarding the admin's token. Gated like the kubeconfig read.
//
//	POST /internal/clusters/{id}/invalidate → 204
func (h *Handler) InvalidateCluster(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if len(payload.Perms["*"]) == 0 && len(payload.Perms[id]) == 0 {
		response.Error(w, http.StatusForbidden, "forbidden: no access to cluster "+id)
		return
	}
	h.svc.Invalidate(cluster.ID(id))
	w.WriteHeader(http.StatusNoContent)
}

// clusterProbeTimeout bounds one connectivity probe (auth-service waits a
// little longer than this on its side).
const clusterProbeTimeout = 10 * time.Second

// ValidateKubeconfig probes a kubeconfig that is not registered yet, on behalf
// of auth-service (registration, rotation, the "test connection" button). The
// credential plugin a kubeconfig may name runs here, where the pod's cloud
// identity (IRSA) lives — auth-service holds neither the binary nor a role.
//
//	POST /internal/clusters/validate {"kubeconfig": "..."} → {"server_version": "...", "uid": "..."}
//
// Internal-only (NOT gateway-routed); the caller must hold a cluster
// registration permission.
func (h *Handler) ValidateKubeconfig(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !payload.HasPermission(auth.PermClustersCreate) && !payload.HasPermission(auth.PermClustersUpdate) {
		response.Error(w, http.StatusForbidden, "forbidden: cluster registration permission required")
		return
	}
	var req struct {
		Kubeconfig string `json:"kubeconfig"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Kubeconfig) == "" {
		response.Error(w, http.StatusBadRequest, "kubeconfig required")
		return
	}
	ver, uid, err := h.svc.ProbeKubeconfig(r.Context(), req.Kubeconfig, clusterProbeTimeout)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"server_version": ver, "uid": uid})
}

// ValidateCluster probes a registered cluster from its stored connection
// details. Gated like the kubeconfig read.
//
//	POST /internal/clusters/{id}/validate → {"server_version": "...", "uid": "..."}
func (h *Handler) ValidateCluster(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if len(payload.Perms["*"]) == 0 && len(payload.Perms[id]) == 0 {
		response.Error(w, http.StatusForbidden, "forbidden: no access to cluster "+id)
		return
	}
	ver, uid, err := h.svc.ProbeCluster(r.Context(), cluster.ID(id), clusterProbeTimeout)
	if errors.Is(err, cluster.ErrNotFound) {
		response.Error(w, http.StatusNotFound, "cluster not found")
		return
	}
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"server_version": ver, "uid": uid})
}

var errForbiddenKubeconfig = forbiddenKubeconfigErr{}

type forbiddenKubeconfigErr struct{}

func (forbiddenKubeconfigErr) Error() string { return "forbidden" }

// auditKubeconfigRead records a k8s.cluster.kubeconfig.read (sensitive read),
// scoped to the cluster. Best-effort — never blocks the response.
func (h *Handler) auditKubeconfigRead(r *http.Request, payload auth.TokenPayload, id string, err error) {
	if h == nil || h.auditStore == nil {
		return
	}
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceK8s
	rec.Action = "k8s.cluster.kubeconfig.read"
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.Cluster = id
	rec.TargetType = "cluster"
	rec.TargetID = id
	if err != nil {
		rec.Result = audit.ResultFailure
		rec.Error = err.Error()
	} else {
		rec.Result = audit.ResultSuccess
	}
	_, _ = h.auditStore.Write(r.Context(), rec)
}
