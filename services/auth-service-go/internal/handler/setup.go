package handler

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/dockersetup"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/k8ssetup"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/response"

	"gopkg.in/yaml.v3"
)

type SetupHandler struct {
	repo *repository.Repository
	cfg  config.Config
}

func NewSetupHandler(repo *repository.Repository, cfg config.Config) *SetupHandler {
	return &SetupHandler{repo: repo, cfg: cfg}
}

// GetSetup handles GET /auth/setup
func (h *SetupHandler) GetSetup(w http.ResponseWriter, r *http.Request) {
	cs, err := h.repo.GetClusterSetup(r.Context())
	if err != nil || cs == nil {
		response.JSON(w, http.StatusOK, model.ClusterSetupStatus{Configured: false})
		return
	}

	status := "unknown"
	var msg *string
	connStatus, connMsg := k8ssetup.CheckK8sServiceHealth(h.cfg.K8sServiceHealthURL, 2)
	status = connStatus
	if connMsg != "" {
		msg = &connMsg
	}

	response.JSON(w, http.StatusOK, model.ClusterSetupStatus{
		Configured:        true,
		Mode:              cs.Mode,
		SecretName:        cs.SecretName,
		ConnectionStatus:  status,
		ConnectionMessage: msg,
	})
}

// PostSetup handles POST /auth/setup
func (h *SetupHandler) PostSetup(w http.ResponseWriter, r *http.Request) {
	existing, _ := h.repo.GetClusterSetup(r.Context())
	if existing != nil {
		response.Error(w, http.StatusConflict, "Already configured")
		return
	}

	var req model.ClusterSetupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Mode != "in_cluster" && req.Mode != "external" {
		response.Error(w, http.StatusBadRequest, "Invalid mode. Must be in_cluster or external")
		return
	}

	var secretName *string

	if req.Mode == "external" {
		if req.Kubeconfig == nil || *req.Kubeconfig == "" {
			response.Error(w, http.StatusBadRequest, "Kubeconfig required for external mode")
			return
		}

		// Validate YAML
		var parsed map[string]interface{}
		if err := yaml.Unmarshal([]byte(*req.Kubeconfig), &parsed); err != nil {
			response.Error(w, http.StatusBadRequest, "Invalid kubeconfig YAML")
			return
		}
		if _, ok := parsed["clusters"]; !ok {
			response.Error(w, http.StatusBadRequest, "Invalid kubeconfig: missing clusters field")
			return
		}
		if _, ok := parsed["users"]; !ok {
			response.Error(w, http.StatusBadRequest, "Invalid kubeconfig: missing users field")
			return
		}

		// Validate connection
		if err := k8ssetup.ValidateKubeconfigConnection([]byte(*req.Kubeconfig), 5); err != nil {
			response.Error(w, http.StatusBadRequest, "Connection failed: "+err.Error())
			return
		}

		if h.cfg.DeploymentMode == "docker" {
			if err := dockersetup.WriteKubeconfigAtomic(h.cfg.DockerKubeconfigPath, []byte(*req.Kubeconfig)); err != nil {
				slog.Error("write kubeconfig failed", "error", err)
				response.Error(w, http.StatusInternalServerError, "Failed to write kubeconfig: "+err.Error())
				return
			}
			slog.Info("kubeconfig written", "path", h.cfg.DockerKubeconfigPath)
		} else {
			// Upsert Secret
			sName := h.cfg.SetupKubeconfigSecret
			if err := k8ssetup.UpsertKubeconfigSecret(r.Context(), h.cfg.SetupNamespace, sName, *req.Kubeconfig); err != nil {
				slog.Error("upsert kubeconfig secret failed", "error", err)
				response.Error(w, http.StatusInternalServerError, "Failed to store kubeconfig: "+err.Error())
				return
			}
			secretName = &sName
		}
	}

	if h.cfg.DeploymentMode != "docker" {
		// Patch ConfigMap
		inCluster := "true"
		if req.Mode == "external" {
			inCluster = "false"
		}
		cmData := map[string]string{
			"IN_CLUSTER":      inCluster,
			"KUBECONFIG_PATH": "/app/kubeconfig.yaml",
		}
		if err := k8ssetup.PatchConfigMap(r.Context(), h.cfg.SetupNamespace, h.cfg.SetupConfigMapName, cmData); err != nil {
			slog.Error("patch configmap failed", "error", err)
			response.Error(w, http.StatusInternalServerError, "Failed to update config: "+err.Error())
			return
		}

		// Restart deployments
		for _, dep := range h.cfg.SetupRestartDeployments {
			if err := k8ssetup.RestartDeployment(r.Context(), h.cfg.SetupNamespace, dep); err != nil {
				slog.Error("restart deployment failed", "deployment", dep, "error", err)
			}
		}
	}

	// Save to DB
	cs, err := h.repo.CreateClusterSetup(r.Context(), req.Mode, secretName)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	response.JSON(w, http.StatusOK, model.ClusterSetupStatus{
		Configured:       true,
		Mode:             cs.Mode,
		SecretName:       cs.SecretName,
		ConnectionStatus: "connected",
	})
}

// RolloutStatus handles GET /auth/setup/rollout-status
func (h *SetupHandler) RolloutStatus(w http.ResponseWriter, r *http.Request) {
	if h.cfg.DeploymentMode == "docker" {
		s := dockersetup.GetStatus(r.Context(), h.cfg.DockerKubeconfigPath, h.cfg.K8sServiceHealthURL)
		response.JSON(w, http.StatusOK, map[string]interface{}{
			"ready": s.FileExists && s.K8sServiceReady,
			"deployments": map[string]interface{}{
				"kubeconfig-file": map[string]interface{}{
					"ready":   s.FileExists,
					"message": fmt.Sprintf("%d bytes", s.FileSize),
				},
				"k8s-service": map[string]interface{}{
					"ready":   s.K8sServiceReady,
					"message": s.Message,
				},
			},
		})
		return
	}
	result := k8ssetup.CheckRolloutStatus(r.Context(), h.cfg.SetupNamespace, h.cfg.SetupRestartDeployments)
	response.JSON(w, http.StatusOK, result)
}
