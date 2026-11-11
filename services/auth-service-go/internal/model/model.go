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
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Email        string  `json:"email"`
	Team         *string `json:"team"`
	RoleID       int     `json:"role_id"`
	RoleName     string  `json:"role_name"`
	PasswordHash string  `json:"-"`
	TokenVersion int     `json:"-"` // bumped to revoke issued tokens ("tv" claim)
	// Login lockout (H13): password failures in the current window, when the
	// last one happened, and until when the account refuses password logins.
	FailedLogins    int        `json:"-"`
	LastFailedLogin *time.Time `json:"-"`
	LockedUntil     *time.Time `json:"-"`
	AuthSource      string     `json:"auth_source"`       // "password" or "oidc" (how the account was created)
	LastLoginAt     *time.Time `json:"last_login_at"`     // last successful sign-in; nil = never
	DormantLockedAt *time.Time `json:"dormant_locked_at"` // set by the dormant-account sweeper; nil = not locked
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

const (
	AuthSourcePassword = "password"
	AuthSourceOIDC     = "oidc"
)

// RoleResponse is the role object embedded in API responses.
type RoleResponse struct {
	ID          int      `json:"id"`
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
}

// UserResponse is the public API representation (no password hash).
type UserResponse struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	Email      string        `json:"email"`
	Team       *string       `json:"team"`
	Role       *RoleResponse `json:"role"`
	AuthSource string        `json:"auth_source"`
	CreatedAt  time.Time     `json:"created_at"`
	UpdatedAt  time.Time     `json:"updated_at"`
	// Account state for the admin pages: last sign-in, the temporary password
	// lock and the dormant lock (nil when not locked).
	LastLoginAt     *time.Time `json:"last_login_at"`
	LockedUntil     *time.Time `json:"locked_until,omitempty"`
	DormantLockedAt *time.Time `json:"dormant_locked_at,omitempty"`
}

func (u *User) ToResponse() UserResponse {
	return UserResponse{
		ID:    u.ID,
		Name:  u.Name,
		Email: u.Email,
		Team:  u.Team,
		Role: &RoleResponse{
			ID:   u.RoleID,
			Name: u.RoleName,
		},
		AuthSource:      u.AuthSource,
		CreatedAt:       u.CreatedAt,
		UpdatedAt:       u.UpdatedAt,
		LastLoginAt:     u.LastLoginAt,
		LockedUntil:     u.LockedUntil,
		DormantLockedAt: u.DormantLockedAt,
	}
}

// ToResponseWithPermissions creates a UserResponse with permissions included.
func (u *User) ToResponseWithPermissions(permissions []string) UserResponse {
	resp := u.ToResponse()
	resp.Role.Permissions = permissions
	return resp
}

// AdminResetPasswordResponse is returned by the admin reset-password endpoint.
// It carries the standard user fields plus the one-time plaintext password
// that was just generated, so the admin can copy it and share with the user.
// The plaintext is NOT stored anywhere — only the bcrypt hash lives in DB.
type AdminResetPasswordResponse struct {
	UserResponse
	TemporaryPassword string `json:"temporary_password"`
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

// Organization represents an organizations row (Team).
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
	Team   *string `json:"team,omitempty"`
	RoleID *int    `json:"role_id,omitempty"`
}

type AdminCreateUserRequest struct {
	Name     string  `json:"name"`
	Email    string  `json:"email"`
	Password string  `json:"password"`
	RoleID   int     `json:"role_id"`
	Team     *string `json:"team,omitempty"`
}

type BulkUpdateRoleRequest struct {
	UserIDs []string `json:"user_ids"`
	RoleID  int      `json:"role_id"`
}

// Why a bulk role change left an account as it was. The screen words them from its catalog.
const (
	BulkRoleFailedChange   = "failed"
	BulkRoleFailedNotFound = "not_found"
	BulkRoleFailedSelf     = "self"
)

type BulkRoleFailure struct {
	UserID string `json:"user_id"`
	Email  string `json:"email,omitempty"`
	Reason string `json:"reason"`
}

// BulkRoleResponse answers a call that did not change everyone: 207, or 500 when it changed nobody it set out to.
// A call that changed everyone answers the list alone.
type BulkRoleResponse struct {
	Detail  string            `json:"detail,omitempty"`
	Updated []UserResponse    `json:"updated"`
	Failed  []BulkRoleFailure `json:"failed"`
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

// Why a bulk creation left an account out. The screen words them from its catalog.
const (
	BulkCreateFailedFields     = "missing_fields"
	BulkCreateFailedName       = "name"
	BulkCreateFailedNameLength = "name_length"
	BulkCreateFailedPassword   = "password"
	BulkCreateFailedRole       = "role"
	BulkCreateFailedCeiling    = "ceiling"
	BulkCreateFailedTeam       = "team"
	BulkCreateFailedExists     = "exists"
	BulkCreateFailedWrite      = "failed"
)

// BulkCreateFailure is one account a bulk creation left out; Detail is what the reason's words cannot say.
type BulkCreateFailure struct {
	Email  string `json:"email"`
	Reason string `json:"reason"`
	Detail string `json:"detail,omitempty"`
}

// CreateUserRefusal answers the form that creates one account: Detail is the server's sentence, for clients that read
// only that; Reason and ReasonDetail are a BulkCreateFailure's.
type CreateUserRefusal struct {
	Detail       string `json:"detail"`
	Reason       string `json:"reason"`
	ReasonDetail string `json:"reason_detail,omitempty"`
}

// BulkCreateUserResponse answers 200, 207 when someone was not created, 500 when a failed write left nobody; Errors is for older clients.
type BulkCreateUserResponse struct {
	Detail  string              `json:"detail,omitempty"`
	Created []UserResponse      `json:"created"`
	Failed  []BulkCreateFailure `json:"failed"`
	Errors  []BulkError         `json:"errors"`
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

// --- Multi-cluster CRUD DTOs ---

// RegisterClusterRequest is the payload for POST /api/v1/clusters.
// Mode is "external" (kubeconfig required) or "self" (in-cluster ServiceAccount).
type RegisterClusterRequest struct {
	Mode         string  `json:"mode"`
	DisplayName  string  `json:"display_name"`
	Kubeconfig   *string `json:"kubeconfig,omitempty"`
	APIServerURL *string `json:"api_server_url,omitempty"`
}

// UpdateClusterRequest is the payload for PATCH /api/v1/clusters/{id}.
// The cluster ID is immutable; only display name and the display-only API
// server URL can change. nil fields are left unchanged.
type UpdateClusterRequest struct {
	DisplayName  *string `json:"display_name,omitempty"`
	APIServerURL *string `json:"api_server_url,omitempty"`
	// Kubeconfig, when set, rotates the external cluster's stored kubeconfig
	// (credential renewal) — the id and all per-cluster RBAC grants are kept.
	Kubeconfig *string `json:"kubeconfig,omitempty"`
	// External Prometheus source. An empty string clears the field; the auth
	// value is written to the cluster-prometheus-<id> Secret and never read back.
	PrometheusURL          *string                `json:"prometheus_url,omitempty"`
	PrometheusClusterLabel *string                `json:"prometheus_cluster_label,omitempty"`
	PrometheusAuth         *PrometheusAuthRequest `json:"prometheus_auth,omitempty"`
	// Prometheus Service inside the cluster, "namespace/service:port"; "" clears it.
	PrometheusService *string `json:"prometheus_service,omitempty"`
	// This cluster's own log store (features.logSearch is the deployment-wide
	// one). An empty string clears the field; the auth value is written to the
	// cluster-logsearch-<id> Secret and never read back.
	LogSearchURL          *string            `json:"log_search_url,omitempty"`
	LogSearchTenant       *string            `json:"log_search_tenant,omitempty"`
	LogSearchClusterLabel *string            `json:"log_search_cluster_label,omitempty"`
	LogSearchAuth         *AuthHeaderRequest `json:"log_search_auth,omitempty"`
}

// AuthHeaderRequest is PrometheusAuthRequest for the other stores a cluster
// can name (its log store).
type AuthHeaderRequest = PrometheusAuthRequest

// PrometheusAuthRequest sets ("bearer" with Token, "basic" with Username and
// Password) or clears ("none") the Authorization header for a cluster's
// external Prometheus.
type PrometheusAuthRequest struct {
	Type     string `json:"type"`
	Token    string `json:"token,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

// ValidateClusterRequest is the payload for POST /api/v1/clusters/validate
// (pre-registration connection test, no DB write).
type ValidateClusterRequest struct {
	Mode       string  `json:"mode"`
	Kubeconfig *string `json:"kubeconfig,omitempty"`
}

// ClusterConnectionResult is returned by the validate / test endpoints.
type ClusterConnectionResult struct {
	Healthy       bool   `json:"healthy"`
	ServerVersion string `json:"server_version,omitempty"`
	Server        string `json:"server,omitempty"`
	Message       string `json:"message,omitempty"`
	// Refused: the caller may not dial this cluster (k8s-service answered 403), which says nothing of its health.
	Refused bool `json:"refused,omitempty"`
}

// ClusterSwitchRequest is the payload for POST /api/v1/audit/cluster-switch.
type ClusterSwitchRequest struct {
	PreviousCluster string `json:"previous_cluster"`
	NewCluster      string `json:"new_cluster"`
}
