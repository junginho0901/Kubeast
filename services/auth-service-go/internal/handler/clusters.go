package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gopkg.in/yaml.v3"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

const clusterValidateTimeout = 10 * time.Second

// ClustersHandler serves the multi-cluster CRUD API. Registration writes a DB
// row plus a kubeconfig secret/file only — no rollout — and k8s-service reads
// the secret lazily on the first ?cluster={id} request (00-COMMON §2-4).
type ClustersHandler struct {
	registry   *cluster.PostgresRegistry
	secrets    cluster.SecretWriter // nil when no store is configured for this mode
	auditStore audit.Store
	cfg        config.Config
}

func NewClustersHandler(registry *cluster.PostgresRegistry, secrets cluster.SecretWriter, auditStore audit.Store, cfg config.Config) *ClustersHandler {
	return &ClustersHandler{registry: registry, secrets: secrets, auditStore: auditStore, cfg: cfg}
}

// ListClusters handles GET /api/v1/clusters[?accessibleOnly=true].
//
//   - default (full registry view): requires admin.clusters.list.
//   - ?accessibleOnly=true: open to any authenticated user, but returns only the
//     clusters the caller holds a per-cluster grant on (the non-"*" keys of their
//     JWT permission matrix). A global admin (admin.clusters.list / "*") sees all.
//     Clusters the caller can't access are not listed at all (00-COMMON §2-3:
//     non-exposure, not a data-level denial) — this powers the picker (step 11).
func (h *ClustersHandler) ListClusters(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	showAll := payload.HasPermission(auth.PermClustersList)
	accessibleOnly := r.URL.Query().Get("accessibleOnly") == "true"
	if !accessibleOnly && !showAll {
		response.Error(w, http.StatusForbidden, "forbidden: requires "+auth.PermClustersList)
		return
	}

	clusters, err := h.registry.ListMeta(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !showAll {
		accessible := make(map[string]struct{})
		for cid := range payload.Perms {
			if cid != "*" {
				accessible[cid] = struct{}{}
			}
		}
		filtered := make([]cluster.Meta, 0, len(clusters))
		for _, m := range clusters {
			if _, ok := accessible[string(m.ID)]; ok {
				filtered = append(filtered, m)
			}
		}
		clusters = filtered
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"items": clusters})
}

// RegisterCluster handles POST /api/v1/clusters (mode: external | self).
func (h *ClustersHandler) RegisterCluster(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(w, r, auth.PermClustersCreate)
	if !ok {
		return
	}

	var req model.RegisterClusterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if strings.TrimSpace(req.DisplayName) == "" {
		response.Error(w, http.StatusBadRequest, "display_name required")
		return
	}
	if cluster.Slugify(req.DisplayName) == "" {
		response.Error(w, http.StatusBadRequest, "display_name must contain alphanumeric characters")
		return
	}

	var (
		meta   *cluster.Meta
		err    error
		apiURL string
	)
	switch req.Mode {
	case "external":
		if req.Kubeconfig == nil || *req.Kubeconfig == "" {
			response.Error(w, http.StatusBadRequest, "kubeconfig required for external mode")
			return
		}
		if verr := validateKubeconfigYAML(*req.Kubeconfig); verr != nil {
			response.Error(w, http.StatusBadRequest, verr.Error())
			return
		}
		if _, verr := validateKubeconfig([]byte(*req.Kubeconfig), clusterValidateTimeout); verr != nil {
			response.Error(w, http.StatusBadRequest, "Connection test failed: "+verr.Error())
			return
		}
		if req.APIServerURL != nil {
			apiURL = *req.APIServerURL
		}
		meta, err = h.registry.AddExternal(r.Context(), req.DisplayName, *req.Kubeconfig, apiURL, payload.Email, h.secrets)

	case "self":
		meta, err = h.registry.AddSelf(r.Context(), req.DisplayName, payload.Email)

	default:
		response.Error(w, http.StatusBadRequest, "Invalid mode. Must be external or self")
		return
	}

	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, cluster.ErrAlreadyExists) {
			status = http.StatusConflict
		} else if req.Mode == "self" {
			// Self registration only fails on bad input (not running in-cluster).
			status = http.StatusBadRequest
		}
		h.audit(r, "admin.cluster.register", payload, cluster.Slugify(req.DisplayName), map[string]any{"mode": req.Mode, "display_name": req.DisplayName}, nil, err)
		response.Error(w, status, err.Error())
		return
	}

	h.audit(r, "admin.cluster.register", payload, string(meta.ID),
		nil, map[string]any{"mode": meta.Mode, "display_name": meta.DisplayName, "api_server_url": meta.APIServerURL}, nil)
	response.JSON(w, http.StatusCreated, meta)
}

// DeleteCluster handles DELETE /api/v1/clusters/{id}.
func (h *ClustersHandler) DeleteCluster(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(w, r, auth.PermClustersDelete)
	if !ok {
		return
	}
	id := cluster.ID(chi.URLParam(r, "id"))

	before, _ := h.registry.GetMeta(r.Context(), id)
	err := h.registry.Remove(r.Context(), id, h.secrets)
	if errors.Is(err, cluster.ErrNotFound) {
		response.Error(w, http.StatusNotFound, "Cluster not found")
		return
	}
	if err != nil {
		h.audit(r, "admin.cluster.delete", payload, string(id), before, nil, err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.audit(r, "admin.cluster.delete", payload, string(id), before, map[string]any{"deleted": true}, nil)
	w.WriteHeader(http.StatusNoContent)
}

// UpdateCluster handles PATCH /api/v1/clusters/{id} (display_name / api_server_url).
func (h *ClustersHandler) UpdateCluster(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(w, r, auth.PermClustersUpdate)
	if !ok {
		return
	}
	id := cluster.ID(chi.URLParam(r, "id"))

	var req model.UpdateClusterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.DisplayName != nil && strings.TrimSpace(*req.DisplayName) == "" {
		response.Error(w, http.StatusBadRequest, "display_name cannot be empty")
		return
	}

	before, _ := h.registry.GetMeta(r.Context(), id)
	meta, err := h.registry.UpdateMeta(r.Context(), id, req.DisplayName, req.APIServerURL)
	if errors.Is(err, cluster.ErrNotFound) {
		response.Error(w, http.StatusNotFound, "Cluster not found")
		return
	}
	if err != nil {
		h.audit(r, "admin.cluster.update", payload, string(id), before, nil, err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.audit(r, "admin.cluster.update", payload, string(id), before, meta, nil)
	response.JSON(w, http.StatusOK, meta)
}

// TestCluster handles POST /api/v1/clusters/{id}/test — re-validates a
// registered cluster's connection and records the health result.
func (h *ClustersHandler) TestCluster(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(w, r, auth.PermClustersList)
	if !ok {
		return
	}
	id := cluster.ID(chi.URLParam(r, "id"))

	info, err := h.registry.Get(r.Context(), id)
	if errors.Is(err, cluster.ErrNotFound) {
		response.Error(w, http.StatusNotFound, "Cluster not found")
		return
	}
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	result := h.checkInfo(info)
	status := "unreachable"
	if result.Healthy {
		status = "healthy"
	}
	if uerr := h.registry.UpdateHealth(r.Context(), id, status); uerr != nil {
		slog.Warn("cluster: update health failed", "id", id, "err", uerr)
	}
	h.audit(r, "admin.cluster.test", payload, string(id), nil, result, nil)
	response.JSON(w, http.StatusOK, result)
}

// ValidateCluster handles POST /api/v1/clusters/validate — a pre-registration
// connection test that writes nothing. Used by the "test connection" button.
func (h *ClustersHandler) ValidateCluster(w http.ResponseWriter, r *http.Request) {
	if _, ok := requirePerm(w, r, auth.PermClustersCreate); !ok {
		return
	}
	var req model.ValidateClusterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Mode == "self" {
		response.JSON(w, http.StatusOK, h.checkInfo(&cluster.Info{Mode: cluster.ModeInCluster, InCluster: true}))
		return
	}
	if req.Kubeconfig == nil || *req.Kubeconfig == "" {
		response.Error(w, http.StatusBadRequest, "kubeconfig required")
		return
	}
	if verr := validateKubeconfigYAML(*req.Kubeconfig); verr != nil {
		response.Error(w, http.StatusBadRequest, verr.Error())
		return
	}
	response.JSON(w, http.StatusOK, h.checkInfo(&cluster.Info{Mode: cluster.ModeExternal, KubeconfigBlob: *req.Kubeconfig}))
}

// checkInfo runs a connectivity check against the resolved cluster connection.
// Self/in-cluster validation only confirms kubeast is in-cluster (the
// ServiceAccount is implicitly trusted); external clusters are dialed.
func (h *ClustersHandler) checkInfo(info *cluster.Info) model.ClusterConnectionResult {
	if info.InCluster || info.Mode == cluster.ModeInCluster {
		if h.cfg.DeploymentMode == "docker" {
			return model.ClusterConnectionResult{Healthy: false, Message: "self cluster is only available in k8s mode"}
		}
		return model.ClusterConnectionResult{Healthy: true, Message: "in-cluster ServiceAccount"}
	}
	if info.KubeconfigBlob == "" {
		return model.ClusterConnectionResult{Healthy: false, Message: "no kubeconfig available"}
	}
	ver, err := validateKubeconfig([]byte(info.KubeconfigBlob), clusterValidateTimeout)
	if err != nil {
		return model.ClusterConnectionResult{Healthy: false, Message: err.Error()}
	}
	return model.ClusterConnectionResult{Healthy: true, ServerVersion: ver}
}

// validateKubeconfigYAML performs the cheap structural checks (valid YAML with
// clusters + users) before the network round-trip.
func validateKubeconfigYAML(kubeconfig string) error {
	var parsed map[string]interface{}
	if err := yaml.Unmarshal([]byte(kubeconfig), &parsed); err != nil {
		return errors.New("Invalid kubeconfig YAML")
	}
	if _, ok := parsed["clusters"]; !ok {
		return errors.New("Invalid kubeconfig: missing clusters field")
	}
	if _, ok := parsed["users"]; !ok {
		return errors.New("Invalid kubeconfig: missing users field")
	}
	return nil
}

// audit writes a best-effort cluster admin audit record (success or failure).
func (h *ClustersHandler) audit(r *http.Request, action string, payload auth.TokenPayload, clusterID string, before, after interface{}, opErr error) {
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAdmin
	rec.Action = action
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.TargetType = "cluster"
	rec.TargetID = clusterID
	rec.Cluster = clusterID
	if before != nil {
		rec.Before = audit.MustJSON(before)
	}
	if after != nil {
		rec.After = audit.MustJSON(after)
	}
	if opErr != nil {
		rec.Result = audit.ResultFailure
		rec.Error = opErr.Error()
	}
	if _, err := h.auditStore.Write(r.Context(), rec); err != nil {
		slog.Error("cluster audit write failed", "action", action, "err", err)
	}
}
