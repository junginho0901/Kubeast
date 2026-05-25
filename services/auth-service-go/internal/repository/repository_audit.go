package repository

import (
	"context"
	"encoding/json"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

func (r *Repository) CreateAuditLog(ctx context.Context, log *model.AuditLog) (int, error) {
	beforeJSON, _ := json.Marshal(map[string]interface{}{})
	afterJSON, _ := json.Marshal(map[string]interface{}{})
	if log.Before != nil {
		beforeJSON = *log.Before
	}
	if log.After != nil {
		afterJSON = *log.After
	}

	var id int
	err := r.pool.QueryRow(ctx,
		`INSERT INTO auth_audit_logs (action, actor_user_id, actor_email, target_user_id, target_email, before, after, request_ip, user_agent, request_id, path, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
		log.Action, log.ActorUserID, log.ActorEmail, log.TargetUserID, log.TargetEmail,
		beforeJSON, afterJSON, log.RequestIP, log.UserAgent, log.RequestID, log.Path, time.Now().UTC(),
	).Scan(&id)
	return id, err
}
