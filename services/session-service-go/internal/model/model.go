package model

import (
	"encoding/json"
	"time"
)

// Session represents a chat session.
type Session struct {
	ID           string    `json:"id"`
	UserID       string    `json:"user_id"`
	ClusterID    string    `json:"cluster_id,omitempty"`
	Title        string    `json:"title"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	MessageCount int       `json:"message_count,omitempty"`
}

// Message represents a chat message.
type Message struct {
	ID        int              `json:"id"`
	SessionID string           `json:"session_id,omitempty"`
	Role      string           `json:"role"`
	Content   string           `json:"content"`
	ToolCalls *json.RawMessage `json:"tool_calls"`
	CreatedAt time.Time        `json:"created_at"`
}

// SessionContext holds tool execution state for a session.
type SessionContext struct {
	ID        int              `json:"id"`
	SessionID string           `json:"session_id"`
	State     *json.RawMessage `json:"state"`
	Cache     *json.RawMessage `json:"cache"`
	UpdatedAt time.Time        `json:"updated_at"`
}

// --- Request / Response DTOs ---

// CreateSessionRequest is the request body for creating a session.
type CreateSessionRequest struct {
	Title string `json:"title"`
}

// UpdateSessionRequest is the request body for updating a session title.
type UpdateSessionRequest struct {
	Title string `json:"title"`
}

// MessageRequest represents a single message in SaveMessagesRequest.
type MessageRequest struct {
	Role      string           `json:"role"`
	Content   string           `json:"content"`
	ToolCalls *json.RawMessage `json:"tool_calls,omitempty"`
}

// SaveMessagesRequest is the request body for saving messages.
type SaveMessagesRequest struct {
	Messages []MessageRequest `json:"messages"`
}

// SessionResponse is the API response for a session (list / create / update).
type SessionResponse struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	MessageCount int       `json:"message_count"`
}

// SessionDetailResponse is the API response for session detail (with messages).
type SessionDetailResponse struct {
	ID        string            `json:"id"`
	Title     string            `json:"title"`
	CreatedAt time.Time         `json:"created_at"`
	UpdatedAt time.Time         `json:"updated_at"`
	Messages  []MessageResponse `json:"messages"`
}

// MessageResponse is a message in the session detail response.
type MessageResponse struct {
	ID        int              `json:"id"`
	Role      string           `json:"role"`
	Content   string           `json:"content"`
	ToolCalls *json.RawMessage `json:"tool_calls"`
	CreatedAt time.Time        `json:"created_at"`
}
