package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/repository"
)

// messagesPage is how many messages one read of a conversation holds.
const messagesPage = 100

// sessionTitleMax is the longest title a rename takes, in characters.
const sessionTitleMax = 100

// sessionStore is what the handler needs of repository.Repository.
type sessionStore interface {
	CreateSession(ctx context.Context, id, userID, clusterID, title string) (*model.Session, error)
	GetSession(ctx context.Context, id string) (*model.Session, error)
	ListSessionsWithMessageCounts(ctx context.Context, userID, clusterID string, limit, offset int, beforeUpdatedAt *time.Time, beforeID *string) ([]model.Session, error)
	UpdateSessionTitle(ctx context.Context, id, title string) error
	DeleteSession(ctx context.Context, id string) error
	GetMessages(ctx context.Context, sessionID string, limit int) ([]model.Message, error)
	GetMessagesBefore(ctx context.Context, sessionID string, beforeID, limit int) ([]model.Message, error)
	AddMessage(ctx context.Context, sessionID, role, content string, toolCalls, usage *json.RawMessage) (*model.Message, error)
	GetMessageCount(ctx context.Context, sessionID string) (int, error)
}

// SessionHandler handles session-related HTTP requests.
type SessionHandler struct {
	repo       sessionStore
	auditStore audit.Writer
}

// NewSessionHandler creates a new SessionHandler. Renaming and deleting a
// conversation are recorded in auditStore (ai.session.rename/.delete).
func NewSessionHandler(repo *repository.Repository, auditStore audit.Writer) *SessionHandler {
	return &SessionHandler{repo: repo, auditStore: auditStore}
}

// recordSession writes ai.session.rename/.delete for the conversation's owner.
func (h *SessionHandler) recordSession(r *http.Request, payload auth.TokenPayload, action, sessionID string, before, after any, err error) {
	if h.auditStore == nil {
		return
	}
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAI
	rec.Action = action
	rec.ActorUserID, rec.ActorEmail = payload.UserID, payload.Email
	rec.TargetType, rec.TargetID = "session", sessionID
	if before != nil {
		rec.Before = audit.MustJSON(before)
	}
	if after != nil {
		rec.After = audit.MustJSON(after)
	}
	rec.Result = audit.ResultSuccess
	if err != nil {
		rec.Result, rec.Error = audit.ResultFailure, err.Error()
	}
	_, _ = h.auditStore.Write(r.Context(), rec) // the mutation already ran; audit.Guarded counts a failure
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

	// Multi-cluster (step 13): scope sessions to the selected cluster (?cluster=,
	// injected by the frontend axios). Empty → all clusters.
	cluster := r.URL.Query().Get("cluster")
	sessions, err := h.repo.ListSessionsWithMessageCounts(
		r.Context(), payload.UserID, cluster, limit, offset, beforeUpdatedAt, beforeID,
	)
	if err != nil {
		slog.Error("list sessions failed", "error", err)
		response.InternalError(w, r, err)
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
	if utf8.RuneCountInString(title) > sessionTitleMax {
		response.Error(w, http.StatusBadRequest, fmt.Sprintf("title: up to %d characters", sessionTitleMax))
		return
	}

	cluster := r.URL.Query().Get("cluster")
	sessionID := uuid.New().String()
	session, err := h.repo.CreateSession(r.Context(), sessionID, payload.UserID, cluster, title)
	if err != nil {
		slog.Error("create session failed", "error", err)
		response.InternalError(w, r, err)
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
		response.InternalError(w, r, err)
		return
	}
	if session == nil || session.UserID != payload.UserID {
		response.Error(w, http.StatusNotFound, "Session not found")
		return
	}

	messages, err := h.repo.GetMessages(r.Context(), sessionID, messagesPage)
	if err != nil {
		slog.Error("get messages failed", "error", err)
		response.InternalError(w, r, err)
		return
	}
	// counted after the page: a message saved between the two reads counts as before it until the next read, never
	// leaving an earlier message uncounted
	total, err := h.repo.GetMessageCount(r.Context(), sessionID)
	if err != nil {
		slog.Error("count messages failed", "error", err)
		response.InternalError(w, r, err)
		return
	}
	before := total - len(messages)
	if before < 0 {
		before = 0
	}

	response.JSON(w, http.StatusOK, model.SessionDetailResponse{
		ID:             session.ID,
		Title:          session.Title,
		CreatedAt:      session.CreatedAt,
		UpdatedAt:      session.UpdatedAt,
		Messages:       messageResponses(messages),
		MessagesBefore: before,
	})
}

// GetEarlierMessages handles GET /sessions/{session_id}/messages?before_id=<message id>: the page of messages right
// before that one, for a conversation longer than GetSession's newest page.
func (h *SessionHandler) GetEarlierMessages(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	sessionID := chi.URLParam(r, "session_id")
	session, err := h.repo.GetSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("get session failed", "error", err)
		response.InternalError(w, r, err)
		return
	}
	if session == nil || session.UserID != payload.UserID {
		response.Error(w, http.StatusNotFound, "Session not found")
		return
	}
	beforeID, err := strconv.Atoi(r.URL.Query().Get("before_id"))
	if err != nil || beforeID < 1 {
		response.Error(w, http.StatusBadRequest, "before_id: a message id")
		return
	}
	messages, err := h.repo.GetMessagesBefore(r.Context(), sessionID, beforeID, messagesPage)
	if err != nil {
		slog.Error("get earlier messages failed", "error", err)
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"messages": messageResponses(messages)})
}

// messageResponses are messages as the API answers them.
func messageResponses(messages []model.Message) []model.MessageResponse {
	out := make([]model.MessageResponse, len(messages))
	for i, m := range messages {
		out[i] = model.MessageResponse{
			ID:        m.ID,
			Role:      m.Role,
			Content:   m.Content,
			ToolCalls: m.ToolCalls,
			Usage:     m.Usage,
			CreatedAt: m.CreatedAt,
		}
	}
	return out
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
		response.InternalError(w, r, err)
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
	// a title a person reads: up to 100 characters, as auth-service holds a role's or a cluster's name
	if utf8.RuneCountInString(req.Title) > sessionTitleMax {
		response.Error(w, http.StatusBadRequest, fmt.Sprintf("title: up to %d characters", sessionTitleMax))
		return
	}

	before, after := map[string]string{"title": existing.Title}, map[string]string{"title": req.Title}
	if err := h.repo.UpdateSessionTitle(r.Context(), sessionID, req.Title); err != nil {
		slog.Error("update session failed", "error", err)
		h.recordSession(r, payload, "ai.session.rename", sessionID, before, after, err)
		response.InternalError(w, r, err)
		return
	}
	h.recordSession(r, payload, "ai.session.rename", sessionID, before, after, nil)

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
		response.InternalError(w, r, err)
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
		if _, err := h.repo.AddMessage(r.Context(), sessionID, msg.Role, msg.Content, msg.ToolCalls, StoppedUsage(msg)); err != nil {
			slog.Error("add message failed", "error", err)
			response.InternalError(w, r, err)
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
		response.InternalError(w, r, err)
		return
	}
	if session == nil || session.UserID != payload.UserID {
		response.Error(w, http.StatusNotFound, "Session not found")
		return
	}

	before := map[string]string{"title": session.Title}
	if err := h.repo.DeleteSession(r.Context(), sessionID); err != nil {
		slog.Error("delete session failed", "error", err)
		h.recordSession(r, payload, "ai.session.delete", sessionID, before, nil, err)
		response.InternalError(w, r, err)
		return
	}
	h.recordSession(r, payload, "ai.session.delete", sessionID, before, nil, nil)

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
