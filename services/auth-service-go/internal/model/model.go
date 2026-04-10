package model

import (
	"encoding/json"
	"time"
)

// Role represents a roles row.
type Role struct {
	ID          int       `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	IsSystem    bool      `json:"is_system"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// RoleWithPermissions is a Role with its associated permissions.
type RoleWithPermissions struct {
	Role
	Permissions []string `json:"permissions"`
}

// User represents an auth_users row.
type User struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Email        string    `json:"email"`
	HQ           *string   `json:"hq"`
	Team         *string   `json:"team"`
	RoleID       int       `json:"role_id"`
	RoleName     string    `json:"role_name"`
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// RoleResponse is the role object embedded in API responses.
type RoleResponse struct {
	ID          int      `json:"id"`
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
}

// UserResponse is the public API representation (no password hash).
type UserResponse struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	Email     string        `json:"email"`
	HQ        *string       `json:"hq"`
	Team      *string       `json:"team"`
	Role      *RoleResponse `json:"role"`
	CreatedAt time.Time     `json:"created_at"`
	UpdatedAt time.Time     `json:"updated_at"`
}

func (u *User) ToResponse() UserResponse {
	return UserResponse{
		ID:    u.ID,
		Name:  u.Name,
		Email: u.Email,
		HQ:    u.HQ,
		Team:  u.Team,
		Role: &RoleResponse{
			ID:   u.RoleID,
			Name: u.RoleName,
		},
		CreatedAt: u.CreatedAt,
		UpdatedAt: u.UpdatedAt,
	}
}

// ToResponseWithPermissions creates a UserResponse with permissions included.
func (u *User) ToResponseWithPermissions(permissions []string) UserResponse {
	resp := u.ToResponse()
	resp.Role.Permissions = permissions
	return resp
}

// AuditLog represents an auth_audit_logs row.
type AuditLog struct {
	ID           int              `json:"id"`
	Action       string           `json:"action"`
	ActorUserID  *string          `json:"actor_user_id"`
	ActorEmail   *string          `json:"actor_email"`
	TargetUserID *string          `json:"target_user_id"`
	TargetEmail  *string          `json:"target_email"`
	Before       *json.RawMessage `json:"before"`
	After        *json.RawMessage `json:"after"`
	RequestIP    *string          `json:"request_ip"`
	UserAgent    *string          `json:"user_agent"`
	RequestID    *string          `json:"request_id"`
	Path         *string          `json:"path"`
	CreatedAt    time.Time        `json:"created_at"`
}

// ClusterSetup represents a cluster_setup row.
type ClusterSetup struct {
	ID         int       `json:"id"`
	Mode       string    `json:"mode"`
	SecretName *string   `json:"secret_name"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Organization represents an organizations row (HQ or Team).
type Organization struct {
	ID        int       `json:"id"`
	Type      string    `json:"type"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

// --- Request DTOs ---

type RegisterRequest struct {
	Name     string  `json:"name"`
	Email    string  `json:"email"`
	Password string  `json:"password"`
	HQ       *string `json:"hq,omitempty"`
	Team     *string `json:"team,omitempty"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

type UpdateRoleRequest struct {
	RoleID int `json:"role_id"`
}

// AdminUpdateUserRequest is the payload for PATCH /auth/admin/users/{user_id}.
// All fields are optional; only the provided ones are updated.
type AdminUpdateUserRequest struct {
	Name   *string `json:"name,omitempty"`
	HQ     *string `json:"hq,omitempty"`
	Team   *string `json:"team,omitempty"`
	RoleID *int    `json:"role_id,omitempty"`
}

type AdminCreateUserRequest struct {
	Name     string  `json:"name"`
	Email    string  `json:"email"`
	Password string  `json:"password"`
	RoleID   int     `json:"role_id"`
	HQ       *string `json:"hq,omitempty"`
	Team     *string `json:"team,omitempty"`
}

type BulkUpdateRoleRequest struct {
	UserIDs []string `json:"user_ids"`
	RoleID  int      `json:"role_id"`
}

// --- Role request DTOs ---

type CreateRoleRequest struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

type UpdateRolePermissionsRequest struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

type BulkCreateUserRequest struct {
	Users []AdminCreateUserRequest `json:"users"`
}

type BulkCreateUserResponse struct {
	Created []UserResponse `json:"created"`
	Errors  []BulkError    `json:"errors"`
}

type BulkError struct {
	Email   string `json:"email"`
	Message string `json:"message"`
}

type ClusterSetupRequest struct {
	Mode       string  `json:"mode"`
	Kubeconfig *string `json:"kubeconfig,omitempty"`
}

// --- Response DTOs ---

type LoginResponse struct {
	AccessToken string       `json:"access_token"`
	TokenType   string       `json:"token_type"`
	User        UserResponse `json:"user"`
}

type ClusterSetupStatus struct {
	Configured        bool    `json:"configured"`
	Mode              string  `json:"mode,omitempty"`
	SecretName        *string `json:"secret_name,omitempty"`
	ConnectionStatus  string  `json:"connection_status,omitempty"`
	ConnectionMessage *string `json:"connection_message,omitempty"`
}
