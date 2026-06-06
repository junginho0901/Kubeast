package handler

import (
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/response"
)

// DeploymentMode handles GET /api/v1/system/deployment-mode.
// The frontend uses it to decide whether the "register self cluster" option is
// available (self registration needs an in-cluster ServiceAccount, k8s mode).
func (h *SetupHandler) DeploymentMode(w http.ResponseWriter, r *http.Request) {
	mode := h.cfg.DeploymentMode
	if mode == "" {
		mode = "k8s"
	}
	response.JSON(w, http.StatusOK, map[string]string{"mode": mode})
}
