package handler

import (
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
}

func NewAuthHandler(repo *repository.Repository, jwtMgr *security.JWTManager, cfg config.Config, auditStore audit.Store) *AuthHandler {
	return &AuthHandler{repo: repo, jwtMgr: jwtMgr, cfg: cfg, auditStore: auditStore}
}
