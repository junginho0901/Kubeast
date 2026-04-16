package handler

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// GetAllPods handles GET /api/v1/pods/all.
func (h *Handler) GetAllPods(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllPods(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetPods handles GET /api/v1/namespaces/{namespace}/pods.
func (h *Handler) GetPods(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	labelSelector := queryParam(r, "label_selector", "")
	data, err := h.svc.GetPods(ctx, namespace, labelSelector)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribePod handles GET /api/v1/namespaces/{namespace}/pods/{name}/describe.
func (h *Handler) DescribePod(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribePod(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetPodYAML handles GET /api/v1/namespaces/{namespace}/pods/{name}/yaml.
func (h *Handler) GetPodYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "pods", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// GetPodLogs handles GET /api/v1/namespaces/{namespace}/pods/{name}/logs.
func (h *Handler) GetPodLogs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	container := queryParam(r, "container", "")
	tailLines := queryParamInt(r, "tail_lines", 100)
	data, err := h.svc.GetPodLogs(ctx, namespace, name, container, int64(tailLines))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetPodRBAC handles GET /api/v1/namespaces/{namespace}/pods/{name}/rbac.
func (h *Handler) GetPodRBAC(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.GetPodRBAC(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeletePod handles DELETE /api/v1/namespaces/{namespace}/pods/{pod_name}.
func (h *Handler) DeletePod(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.pod.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "pod_name")
	force := queryParamBool(r, "force", false)
	err := h.svc.DeletePod(ctx, namespace, name, force)
	h.recordAudit(r, "k8s.pod.delete", "pod", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// PodLogsWS handles WebSocket pod log streaming.
// GET /api/v1/namespaces/{namespace}/pods/{name}/logs/ws?container=&tail_lines=100
func (h *Handler) PodLogsWS(w http.ResponseWriter, r *http.Request) {
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	container := queryParam(r, "container", "")
	tailLines := queryParamInt(r, "tail_lines", 100)

	// Authenticate via cookie (browser WebSocket can't set Authorization header)
	_, ok := auth.FromContext(r.Context())
	if !ok {
		// If middleware didn't populate auth, try to upgrade then close with 1008
		conn, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "Missing auth token"))
		conn.Close()
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	slog.Info("pod logs ws connected", "namespace", namespace, "pod", name, "container", container)

	ctx := r.Context()

	// Retry loop for pods that are still initializing
	maxRetries := 6
	backoff := time.Second

	for attempt := 0; attempt <= maxRetries; attempt++ {
		stream, err := h.svc.StreamPodLogs(ctx, namespace, name, container, int64(tailLines))
		if err != nil {
			errMsg := err.Error()
			// Retryable conditions (pod initializing, container creating, etc.)
			retryable := false
			for _, marker := range []string{"waiting to start", "podinitializing", "containercreating", "is waiting"} {
				if containsLower(errMsg, marker) {
					retryable = true
					break
				}
			}
			if retryable && attempt < maxRetries {
				slog.Info("pod not ready, retrying", "attempt", attempt+1, "err", errMsg)
				select {
				case <-ctx.Done():
					return
				case <-time.After(backoff):
					backoff *= 2
					if backoff > 10*time.Second {
						backoff = 10 * time.Second
					}
					continue
				}
			}
			slog.Error("stream pod logs failed", "err", err)
			conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseInternalServerErr, errMsg))
			return
		}
		defer stream.Close()

		// Pipe K8s log stream -> WebSocket
		buf := make([]byte, 4096)
		for {
			n, readErr := stream.Read(buf)
			if n > 0 {
				if writeErr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); writeErr != nil {
					slog.Info("ws write error (client disconnected)", "err", writeErr)
					return
				}
			}
			if readErr != nil {
				// Stream ended (pod terminated or EOF)
				slog.Info("pod log stream ended", "namespace", namespace, "pod", name, "err", readErr)
				return
			}
		}
	}
}

func containsLower(s, substr string) bool {
	return strings.Contains(strings.ToLower(s), substr)
}
