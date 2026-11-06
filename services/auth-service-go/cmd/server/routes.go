package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/internalauth"
)

// publicAuthRoutes registers the /api/v1/auth routes that take no token.
func publicAuthRoutes(r chi.Router, authHandler *handler.AuthHandler, setupHandler *handler.SetupHandler, internalAPIToken string) {
	// The two that take credentials accept only application/json bodies (login
	// CSRF: a cross-site form cannot send that content type without a preflight).
	r.With(handler.RequireJSON).Post("/register", authHandler.Register)
	r.With(handler.RequireJSON).Post("/login", authHandler.Login)
	r.Post("/logout", authHandler.Logout)
	// OIDC login (provider chosen by configuration); the session it sets is
	// the same cookie a password login sets.
	r.Get("/oidc/config", authHandler.OIDCConfig)
	r.Get("/oidc/login", authHandler.OIDCLogin)
	r.Get("/oidc/callback", authHandler.OIDCCallback)
	r.Get("/jwks.json", authHandler.JWKS)
	r.Get("/.well-known/jwks.json", authHandler.JWKS)
	// Service-to-service: the other services' validators ask for the
	// bearer's current token_version (not routed by the gateway).
	r.Get("/internal/token-version/{userID}", authHandler.TokenVersion)
	// The alert investigator's short token (features.alertInvestigation):
	// ai-service asks with the internal token, per investigation.
	r.With(internalauth.Middleware(internalAPIToken)).Post("/internal/investigator-token", authHandler.InvestigatorToken)
	// API key → access token (Authorization: Bearer kbk_…); the gateway
	// rate-limits it like sign-in.
	r.Post("/token", authHandler.ExchangeAPIKey)

	// Setup: only "is a cluster registered yet" is public (login page routing).
	r.Get("/setup", setupHandler.GetSetupPublic)

	// Public (for the registration form's dropdown)
	r.Get("/organizations", authHandler.ListOrganizations)
}

// topLevelRoutes registers multi-cluster CRUD, system info and the cluster-switch
// audit. They live outside /api/v1/auth and all require a valid token; the
// admin.clusters.* permission is enforced inside each cluster handler.
func topLevelRoutes(r chi.Router, authMiddleware func(http.Handler) http.Handler, authHandler *handler.AuthHandler, clustersHandler *handler.ClustersHandler, setupHandler *handler.SetupHandler, auditStore audit.Store) {
	r.Group(func(r chi.Router) {
		r.Use(authMiddleware)
		r.Use(handler.AdminWritesGate(auditStore))

		r.Get("/api/v1/clusters", clustersHandler.ListClusters)
		r.Post("/api/v1/clusters", clustersHandler.RegisterCluster)
		r.Post("/api/v1/clusters/validate", clustersHandler.ValidateCluster)
		r.Delete("/api/v1/clusters/{id}", clustersHandler.DeleteCluster)
		r.Patch("/api/v1/clusters/{id}", clustersHandler.UpdateCluster)
		r.Post("/api/v1/clusters/{id}/test", clustersHandler.TestCluster)

		r.Get("/api/v1/system/deployment-mode", setupHandler.DeploymentMode)
		// The picker's own beacon: no key has a picker, and its row reads as the person's.
		r.With(handler.RefuseAPIKeyToken(auditStore, "user.cluster.switch")).Post("/api/v1/audit/cluster-switch", authHandler.ClusterSwitch)
	})
}

// protectedAuthRoutes registers the /api/v1/auth routes that take a token. The
// caller adds the auth middleware and the audit gate around them.
func protectedAuthRoutes(r chi.Router, authHandler *handler.AuthHandler, roleHandler *handler.RoleHandler, setupHandler *handler.SetupHandler, auditStore audit.Store) {
	sessionOnly := func(action string) func(http.Handler) http.Handler {
		return handler.RefuseAPIKeyToken(auditStore, action)
	}

	// Setup wizard (admin.clusters.create, checked in the handler)
	r.Get("/setup/status", setupHandler.GetSetup)
	r.Post("/setup", setupHandler.PostSetup)
	r.Get("/setup/rollout-status", setupHandler.RolloutStatus)

	r.Get("/me", authHandler.Me)
	r.Post("/refresh", authHandler.Refresh)
	r.With(sessionOnly("user.password.change")).Post("/change-password", authHandler.ChangePassword)
	r.Get("/roles", roleHandler.ListRoles)
	r.Get("/permissions", roleHandler.ListPermissions)

	// Admin endpoints
	r.Post("/admin/roles", roleHandler.CreateRole)
	r.Put("/admin/roles/{id}", roleHandler.UpdateRole)
	r.Delete("/admin/roles/{id}", roleHandler.DeleteRole)
	r.Post("/admin/organizations", authHandler.AdminCreateOrganization)
	r.Delete("/admin/organizations/{id}", authHandler.AdminDeleteOrganization)
	r.Get("/admin/audit-logs", authHandler.AdminListAuditLogs)
	r.Get("/admin/audit-logs/export", authHandler.AdminExportAuditLogs)
	r.Get("/admin/ai-usage", authHandler.AdminAIUsage)
	r.Post("/admin/users/bulk", authHandler.AdminBulkCreateUsers)
	r.Patch("/admin/users/bulk-role", authHandler.AdminBulkUpdateRole)
	r.Post("/admin/users", authHandler.AdminCreateUser)
	r.Get("/admin/users", authHandler.AdminListUsers)
	r.Get("/admin/oidc/groups", authHandler.AdminOIDCGroups)
	r.Patch("/admin/users/{user_id}", authHandler.AdminUpdateUser)
	r.Post("/admin/users/{user_id}/reset-password", authHandler.AdminResetPassword)
	r.Delete("/admin/users/{user_id}", authHandler.AdminDeleteUser)

	// Per-cluster role grants (step 08) — admin.users.update.
	r.Get("/admin/users/{user_id}/cluster-roles", authHandler.GetUserClusterRoles)
	r.Get("/admin/users/{user_id}/cluster-grants", authHandler.GetUserClusterGrants)
	r.Put("/admin/users/{user_id}/cluster-roles/{cluster_id}", authHandler.SetUserClusterRole)
	r.Delete("/admin/users/{user_id}/cluster-roles/{cluster_id}", authHandler.DeleteUserClusterRole)
	// Inverse view: the per-cluster access list (who has a grant on a cluster).
	r.Get("/admin/clusters/{cluster_id}/user-roles", authHandler.GetClusterUserRoles)

	// Access requests: a user asks for a higher role on a cluster for a
	// bounded time; admin.users.update approves or rejects (not their own).
	r.Get("/access-requests/config", authHandler.AccessRequestsConfig)
	r.Get("/access-requests", authHandler.ListMyAccessRequests)
	// A key may ask: the MCP tool request_access files through here, and an admin decides.
	r.Post("/access-requests", authHandler.CreateAccessRequest)
	r.With(sessionOnly("access.request.cancel")).Delete("/access-requests/{id}", authHandler.CancelAccessRequest)
	r.Get("/admin/access-requests", authHandler.AdminListAccessRequests)
	r.Post("/admin/access-requests/{id}/approve", authHandler.AdminApproveAccessRequest)
	r.Post("/admin/access-requests/{id}/reject", authHandler.AdminRejectAccessRequest)

	// API keys: a user's own (issue, list, revoke); admin.users.update
	// lists and revokes anyone's, never issues.
	r.Get("/api-keys/config", authHandler.APIKeysConfig)
	r.Get("/api-keys", authHandler.ListMyAPIKeys)
	r.With(sessionOnly("user.apikey.create")).Post("/api-keys", authHandler.CreateAPIKey)
	r.With(sessionOnly("user.apikey.delete")).Delete("/api-keys/{id}", authHandler.DeleteMyAPIKey)
	r.Get("/admin/users/{user_id}/api-keys", authHandler.AdminListUserAPIKeys)
	r.Delete("/admin/users/{user_id}/api-keys/{id}", authHandler.AdminDeleteUserAPIKey)

	// Access review: the periodic "who has what" report, its CSV and the
	// sign-off that records a review was done (admin.review.*).
	r.Get("/access-review/config", authHandler.AccessReviewConfig)
	r.Get("/admin/access-review", authHandler.AdminAccessReview)
	r.Get("/admin/access-review/export", authHandler.AdminAccessReviewExport)
	r.Post("/admin/access-review/signoff", authHandler.AdminAccessReviewSignoff)
	r.Get("/admin/access-review/history", authHandler.AdminAccessReviewHistory)
	r.Get("/admin/access-review/history/{id}", authHandler.AdminAccessReviewSnapshot)

	// Dormant accounts: the config the console reads, "sweep now" and
	// unlock (admin.users.update).
	r.Get("/dormant-accounts/config", authHandler.DormantAccountsConfig)
	r.Post("/admin/dormant-accounts/sweep", authHandler.AdminDormantSweep)
	r.Post("/admin/users/{user_id}/unlock", authHandler.AdminUnlockUser)

	// Audit log integrity: chain status, a verification run
	// (admin.audit.read) and "anchor now" (admin.audit.export).
	r.Get("/admin/audit/integrity", authHandler.AuditIntegrityStatus)
	r.Post("/admin/audit/integrity/verify", authHandler.AdminAuditVerify)
	r.Post("/admin/audit/integrity/anchor", authHandler.AdminAuditAnchor)
}
