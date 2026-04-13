package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/repository"
)

// SessionHandler handles session-related HTTP requests.
type SessionHandler struct {
	repo *repository.Repository
}

// NewSessionHandler creates a new SessionHandler.
func NewSessionHandler(repo *repository.Repository) *SessionHandler {
	return &SessionHandler{repo: repo}
}

// ListSessions handles GET /sessions
func (h *SessionHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	limit := queryParamInt(r, "limit", 50)
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}

	offset := queryParamInt(r, "offset", 0)
	if offset < 0 {
		offset = 0
	}

	var beforeUpdatedAt *time.Time
	if v := r.URL.Query().Get("before_updated_at"); v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			t, err = time.Parse("2006-01-02T15:04:05", v)
		}
		if err == nil {
			beforeUpdatedAt = &t
		}
	}

	var beforeID *string
	if v := r.URL.Query().Get("before_id"); v != "" {
		beforeID = &v
	}

	sessions, err := h.repo.ListSessionsWithMessageCounts(
		r.Context(), payload.UserID, limit, offset, beforeUpdatedAt, beforeID,
	)
	if err != nil {
		slog.Error("list sessions failed", "error", err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	result := make([]model.SessionResponse, len(sessions))
	for i, s := range sessions {
		result[i] = model.SessionResponse{
			ID:           s.ID,
			Title:        s.Title,
			CreatedAt:    s.CreatedAt,
			UpdatedAt:    s.UpdatedAt,
			MessageCount: s.MessageCount,
		}
	}

	response.JSON(w, http.StatusOK, result)
}

// CreateSession handles POST /sessions
func (h *SessionHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	var req model.CreateSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// If body is empty or invalid, use default title
		req.Title = ""
	}

	title := req.Title
	if title == "" {
		title = "New Chat"
	}

	sessionID := uuid.New().String()
	session, err := h.repo.CreateSession(r.Context(), sessionID, payload.UserID, title)
	if err != nil {
		slog.Error("create session failed", "error", err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	response.JSON(w, http.StatusOK, model.SessionResponse{
		ID:           session.ID,
		Title:        session.Title,
		CreatedAt:    session.CreatedAt,
		UpdatedAt:    session.UpdatedAt,
		MessageCount: 0,
	})
}

// GetSession handles GET /sessions/{session_id}
func (h *SessionHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	sessionID := chi.URLParam(r, "session_id")

	session, err := h.repo.GetSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("get session failed", "error", err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if session == nil || session.UserID != payload.UserID {
		response.Error(w, http.StatusNotFound, "Session not found")
		return
	}

	messages, err := h.repo.GetMessages(r.Context(), sessionID, 100)
	if err != nil {
		slog.Error("get messages failed", "error", err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	msgResponses := make([]model.MessageResponse, len(messages))
	for i, m := range messages {
		msgResponses[i] = model.MessageResponse{
			ID:        m.ID,
			Role:      m.Role,
			Content:   m.Content,
			ToolCalls: m.ToolCalls,
			CreatedAt: m.CreatedAt,
		}
	}

	response.JSON(w, http.StatusOK, model.SessionDetailResponse{
		ID:        session.ID,
		Title:     session.Title,
		CreatedAt: session.CreatedAt,
		UpdatedAt: session.UpdatedAt,
		Messages:  msgResponses,
	})
}

// UpdateSession handles PATCH /sessions/{session_id}
func (h *SessionHandler) UpdateSession(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	sessionID := chi.URLParam(r, "session_id")

	existing, err := h.repo.GetSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("get session failed", "error", err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if existing == nil || existing.UserID != payload.UserID {
		response.Error(w, http.StatusNotFound, "Session not found")
		return
	}

	var req model.UpdateSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if err := h.repo.UpdateSessionTitle(r.Context(), sessionID, req.Title); err != nil {
		slog.Error("update session failed", "error", err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	session, err := h.repo.GetSession(r.Context(), sessionID)
	if err != nil || session == nil {
		response.Error(w, http.StatusNotFound, "Session not found")
		return
	}

	msgCount, err := h.repo.GetMessageCount(r.Context(), sessionID)
	if err != nil {
		msgCount = 0
	}

	response.JSON(w, http.StatusOK, model.SessionResponse{
		ID:           session.ID,
		Title:        session.Title,
		CreatedAt:    session.CreatedAt,
		UpdatedAt:    session.UpdatedAt,
		MessageCount: msgCount,
	})
}

// SaveMessages handles POST /sessions/{session_id}/messages
func (h *SessionHandler) SaveMessages(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	sessionID := chi.URLParam(r, "session_id")

	session, err := h.repo.GetSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("get session failed", "error", err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if session == nil || session.UserID != payload.UserID {
		response.Error(w, http.StatusNotFound, "Session not found")
		return
	}

	var req model.SaveMessagesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	for _, msg := range req.Messages {
		if _, err := h.repo.AddMessage(r.Context(), sessionID, msg.Role, msg.Content, msg.ToolCalls); err != nil {
			slog.Error("add message failed", "error", err)
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Messages saved successfully",
	})
}

// DeleteSession handles DELETE /sessions/{session_id}
func (h *SessionHandler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	sessionID := chi.URLParam(r, "session_id")

	session, err := h.repo.GetSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("get session failed", "error", err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if session == nil || session.UserID != payload.UserID {
		response.Error(w, http.StatusNotFound, "Session not found")
		return
	}

	if err := h.repo.DeleteSession(r.Context(), sessionID); err != nil {
		slog.Error("delete session failed", "error", err)
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	response.JSON(w, http.StatusOK, map[string]string{
		"message": "Session deleted successfully",
	})
}

// queryParamInt extracts an integer query parameter with a default value.
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
