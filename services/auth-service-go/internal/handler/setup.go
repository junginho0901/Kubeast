package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/k8ssetup"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// setupClusterDisplayName is the display name (and slug → id) given to the
// first cluster registered through the initial Setup flow. Using "default"
// keeps the single-cluster fallback (?cluster=default and the no-param default)
// working unchanged. Admins can rename it later (PATCH); the id stays "default".
const setupClusterDisplayName = "default"

// SetupHandler drives the initial cluster registration. Since step 07 it shares
// the same rollout-free registration path as the cluster CRUD API: it writes a
// `clusters` row + a kubeconfig secret/file and k8s-service reads it lazily on
// the first request — no ConfigMap patch, no deployment restart (00-COMMON §2-4).
type SetupHandler struct {
	cfg      config.Config
	registry *cluster.PostgresRegistry
	secrets  cluster.SecretWriter
}

func NewSetupHandler(cfg config.Config, registry *cluster.PostgresRegistry, secrets cluster.SecretWriter) *SetupHandler {
	return &SetupHandler{cfg: cfg, registry: registry, secrets: secrets}
}

// GetSetup handles GET /auth/setup. "Configured" now means at least one cluster
// is registered (the cluster_setup single-row table is retired).
func (h *SetupHandler) GetSetup(w http.ResponseWriter, r *http.Request) {
	id, err := h.registry.Default(r.Context())
	if errors.Is(err, cluster.ErrNotFound) {
		response.JSON(w, http.StatusOK, model.ClusterSetupStatus{Configured: false})
		return
	}
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	meta, _ := h.registry.GetMeta(r.Context(), id)
	mode := ""
	if meta != nil {
		mode = string(meta.Mode)
	}

	connStatus, connMsg := k8ssetup.CheckK8sServiceHealth(h.cfg.K8sServiceHealthURL, 2)
	var msg *string
	if connMsg != "" {
		msg = &connMsg
	}
	response.JSON(w, http.StatusOK, model.ClusterSetupStatus{
		Configured:        true,
		Mode:              mode,
		ConnectionStatus:  connStatus,
		ConnectionMessage: msg,
	})
}

// PostSetup handles POST /auth/setup — registers the first cluster.
//
// Rollout-free: the kubeconfig is stored as a Secret (k8s) or file (docker) and
// the DB row is inserted. k8s-service picks it up on the next request; nothing
// is restarted.
func (h *SetupHandler) PostSetup(w http.ResponseWriter, r *http.Request) {
	if _, err := h.registry.Default(r.Context()); err == nil {
		response.Error(w, http.StatusConflict, "Already configured")
		return
	} else if !errors.Is(err, cluster.ErrNotFound) {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	var req model.ClusterSetupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	switch req.Mode {
	case "external":
		if req.Kubeconfig == nil || *req.Kubeconfig == "" {
			response.Error(w, http.StatusBadRequest, "Kubeconfig required for external mode")
			return
		}
		if verr := validateKubeconfigYAML(*req.Kubeconfig); verr != nil {
			response.Error(w, http.StatusBadRequest, verr.Error())
			return
		}
		if _, verr := validateKubeconfig([]byte(*req.Kubeconfig), clusterValidateTimeout); verr != nil {
			response.Error(w, http.StatusBadRequest, "Connection failed: "+verr.Error())
			return
		}
		if _, err := h.registry.AddExternal(r.Context(), setupClusterDisplayName, *req.Kubeconfig, "", "setup", h.secrets); err != nil {
			response.Error(w, http.StatusInternalServerError, "Failed to register cluster: "+err.Error())
			return
		}

	case "in_cluster":
		if _, err := h.registry.AddSelf(r.Context(), setupClusterDisplayName, "setup"); err != nil {
			response.Error(w, http.StatusBadRequest, "Failed to register self cluster: "+err.Error())
			return
		}

	default:
		response.Error(w, http.StatusBadRequest, "Invalid mode. Must be in_cluster or external")
		return
	}

	response.JSON(w, http.StatusOK, model.ClusterSetupStatus{
		Configured:       true,
		Mode:             req.Mode,
		ConnectionStatus: "connected",
	})
}

// RolloutStatus handles GET /auth/setup/rollout-status.
//
// Registration is rollout-free, so "ready" now just means k8s-service can reach
// the freshly registered cluster (the UI's old "waiting for rollout" step
// becomes a connection check — 00-COMMON §2-4).
func (h *SetupHandler) RolloutStatus(w http.ResponseWriter, r *http.Request) {
	connStatus, connMsg := k8ssetup.CheckK8sServiceHealth(h.cfg.K8sServiceHealthURL, 2)
	ready := connStatus == "connected"
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"ready": ready,
		"deployments": map[string]interface{}{
			"k8s-service": map[string]interface{}{
				"ready":   ready,
				"message": connMsg,
			},
		},
	})
}
