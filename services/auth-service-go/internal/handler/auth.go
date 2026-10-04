package handler

import (
	"sync"

	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/audit"
)

type AuthHandler struct {
	repo       *repository.Repository
	jwtMgr     *security.JWTManager
	cfg        config.Config
	auditStore audit.Store
	oidc       *oidcClient
	// dummyHash is verified against when the login email does not exist, so
	// an unknown address costs the same as a wrong password (no timing
	// enumeration). Built once with the configured iteration count.
	dummyOnce sync.Once
	dummyHash string
}

func (h *AuthHandler) dummyPasswordHash() string {
	h.dummyOnce.Do(func() {
		if hsh, err := security.HashPassword("kubeast-dummy-"+uuid.NewString(), h.cfg.PasswordHashIterations); err == nil {
			h.dummyHash = hsh
		}
	})
	return h.dummyHash
}

func NewAuthHandler(repo *repository.Repository, jwtMgr *security.JWTManager, cfg config.Config, auditStore audit.Store) *AuthHandler {
	return &AuthHandler{repo: repo, jwtMgr: jwtMgr, cfg: cfg, auditStore: auditStore, oidc: newOIDCClient(cfg.OIDC)}
}
