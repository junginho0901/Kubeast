package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/junginho0901/kube-assistant/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kube-assistant/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kube-assistant/services/pkg/auth"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// Handler holds the dependencies for HTTP handlers.
type Handler struct {
	svc *k8s.Service
	cfg config.Config
}

// New creates a new Handler.
func New(svc *k8s.Service, cfg config.Config) *Handler {
	return &Handler{
		svc: svc,
		cfg: cfg,
	}
}

// requirePermission checks that the authenticated user has the given permission.
func (h *Handler) requirePermission(r *http.Request, perm string) error {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		return fmt.Errorf("unauthorized")
	}
	if !payload.HasPermission(perm) {
		return fmt.Errorf("forbidden: requires %s permission", perm)
	}
	return nil
}

// queryParam returns a query parameter value or a default.
func queryParam(r *http.Request, key, defaultVal string) string {
	v := r.URL.Query().Get(key)
	if v == "" {
		return defaultVal
	}
	return v
}

// queryParamInt returns a query parameter as int or a default.
func queryParamInt(r *http.Request, key string, defaultVal int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return defaultVal
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return defaultVal
	}
	return i
}

// queryParamBool returns a query parameter as bool or a default.
func queryParamBool(r *http.Request, key string, defaultVal bool) bool {
	v := r.URL.Query().Get(key)
	if v == "" {
		return defaultVal
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return defaultVal
	}
	return b
}

// handleError sends an appropriate error response based on the error message.
func (h *Handler) handleError(w http.ResponseWriter, err error) {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "unauthorized"):
		response.Error(w, http.StatusUnauthorized, msg)
	case strings.Contains(msg, "forbidden"):
		response.Error(w, http.StatusForbidden, msg)
	case strings.Contains(msg, "not found"):
		response.Error(w, http.StatusNotFound, msg)
	case strings.Contains(msg, "already exists"):
		response.Error(w, http.StatusConflict, msg)
	default:
		response.Error(w, http.StatusInternalServerError, msg)
	}
}

// decodeJSON decodes the request body into the given target.
func decodeJSON(r *http.Request, target interface{}) error {
	if r.Body == nil {
		return fmt.Errorf("request body is empty")
	}
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(target)
}
