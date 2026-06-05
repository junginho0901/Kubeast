package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

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
//
// Audit: 명시적 사용자 행위 (PodInfo 의 "Load Logs" 또는 PodLogsTab 의
// "Download" 버튼). logs 에 token / password 가 노출되기도 하니 누가 언제 어떤
// container 의 몇 줄을 가져갔는지 기록. 자동 폴링 없으니 noise X.
func (h *Handler) GetPodLogs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	container := queryParam(r, "container", "")
	tailLines := queryParamInt(r, "tail_lines", 100)
	data, err := h.svc.GetPodLogs(ctx, namespace, name, container, int64(tailLines))

	// after payload — container + tail_lines (logs 본문은 audit 에 저장 X — DB
	// 폭증 + 자체 logs 가 audit 데이터 라 순환 문제).
	after, _ := json.Marshal(map[string]interface{}{
		"container":  container,
		"tail_lines": tailLines,
	})
	h.recordAuditWithPayload(r, "k8s.pod.logs.read", "pod", name, namespace, err, nil, after)

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

// PodLogsSSE handles GET /api/v1/namespaces/{namespace}/pods/{name}/logs/stream
//
// Server-Sent Events 로 pod logs 를 라인 단위로 stream. 단방향이라 client 는
// query param 으로만 제어. browser EventSource 가 자동 reconnect 처리하므로
// frontend retry 로직 불필요.
//
// 이전 WebSocket 구현의 주요 회귀 (`defer stream.Close()` 가 for retry 루프
// 안에 있어 stream cleanup 이 함수 종료까지 지연되며 inotify watcher 누적)
// 도 정상 위치로 옮기며 해결.
func (h *Handler) PodLogsSSE(w http.ResponseWriter, r *http.Request) {
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	container := queryParam(r, "container", "")
	tailLines := queryParamInt(r, "tail_lines", 100)

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// nginx ingress 의 proxy_buffering 을 응답 단위로 끔
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()
	slog.Info("pod logs sse connected", "namespace", namespace, "pod", name, "container", container)

	// Pod 가 초기화 중일 때 retry. SSE 헤더 이미 보냈으므로 retry 실패 시
	// error 이벤트로 알림.
	stream, err := h.retryStreamPodLogs(ctx, w, flusher, namespace, name, container, int64(tailLines))
	if err != nil {
		// 이미 client 에 error 이벤트 전송됨
		return
	}
	defer stream.Close()

	// Line scanner — 큰 로그 줄도 받게 64KiB → 1MiB buffer.
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return
		}
		line := scanner.Text()
		// SSE 메시지 = 한 로그 줄. data: prefix + 빈 줄로 종료.
		if _, err := fmt.Fprintf(w, "data: %s\n\n", line); err != nil {
			slog.Info("pod logs sse write error (client disconnect)", "err", err)
			return
		}
		flusher.Flush()
	}

	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		slog.Warn("pod logs sse scanner error", "err", err)
	}
	slog.Info("pod logs sse ended", "namespace", namespace, "pod", name)
}

// retryStreamPodLogs — Pod 가 ContainerCreating 등 아직 초기화 중인 경우
// exponential backoff 으로 재시도. 성공 시 io.ReadCloser 반환, 영구 실패 시
// SSE error 이벤트 전송 후 error 반환.
func (h *Handler) retryStreamPodLogs(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, namespace, name, container string, tailLines int64) (io.ReadCloser, error) {
	const maxRetries = 6
	backoff := time.Second

	for attempt := 0; attempt <= maxRetries; attempt++ {
		stream, err := h.svc.StreamPodLogs(ctx, namespace, name, container, tailLines)
		if err == nil {
			return stream, nil
		}

		errMsg := err.Error()
		retryable := false
		for _, marker := range []string{"waiting to start", "podinitializing", "containercreating", "is waiting"} {
			if containsLower(errMsg, marker) {
				retryable = true
				break
			}
		}

		if !retryable || attempt >= maxRetries {
			slog.Error("stream pod logs failed", "err", err)
			fmt.Fprintf(w, "event: error\ndata: %s\n\n", escapeSSE(errMsg))
			flusher.Flush()
			return nil, err
		}

		slog.Info("pod not ready, retrying", "attempt", attempt+1, "err", errMsg)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(backoff):
			backoff *= 2
			if backoff > 10*time.Second {
				backoff = 10 * time.Second
			}
		}
	}

	return nil, fmt.Errorf("max retries reached")
}

// escapeSSE — SSE data 라인 안에 줄바꿈 / 캐리지 리턴이 끼면 메시지 경계가
// 깨지므로 단순 escape. 실제 로그 줄은 bufio.Scanner 가 split 한 거라 안전.
// error 텍스트 같은 곳에서만 필요.
func escapeSSE(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", " ")
	return s
}

func containsLower(s, substr string) bool {
	return strings.Contains(strings.ToLower(s), substr)
}
