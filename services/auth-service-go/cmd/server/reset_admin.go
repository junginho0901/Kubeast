package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

const actionAccountRecover = "user.account.recover"

// recoveryStore is what reset-admin needs from the repository.
type recoveryStore interface {
	GetUserByEmail(ctx context.Context, email string) (*model.User, error)
	GetRoleByName(ctx context.Context, name string) (*model.RoleWithPermissions, error)
	CreateUser(ctx context.Context, u *model.User) error
	UpdateUserPassword(ctx context.Context, id, passwordHash string) error
	UpdateUserRole(ctx context.Context, id string, roleID int) error
	UnlockUser(ctx context.Context, id string) (bool, error)
	BumpTokenVersion(ctx context.Context, id string) error
}

// runResetAdmin is `server reset-admin [--email <account>]`, to get the admin account back when its password is lost,
// it is locked or it lost the Admin role. Run it where auth-service runs, so it has the service's database settings:
//
//	kubectl -n <namespace> exec deploy/auth-service -- /app/server reset-admin
//	docker compose exec auth-service /app/server reset-admin
//
// The account (DEFAULT_ADMIN_EMAIL unless --email) gets the password in DEFAULT_ADMIN_PASSWORD — the chart's Secret,
// read with the command the install notes print — and the Admin role; its password and dormant locks are cleared and
// its sessions end. A missing account is created. The password is never printed or passed on the command line.
func runResetAdmin(args []string, out io.Writer) int {
	cfg := config.Load()
	fs := flag.NewFlagSet("reset-admin", flag.ContinueOnError)
	fs.SetOutput(out)
	email := fs.String("email", cfg.DefaultAdminEmail, "the account to recover")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if cfg.DefaultAdminPassword == "" || (cfg.DefaultAdminPassword == "change-me-do-not-use-in-prod" && !cfg.Debug) {
		fmt.Fprintln(out, "reset-admin: DEFAULT_ADMIN_PASSWORD is empty or the built-in placeholder; set the Secret's value first (the chart generates one)")
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURLForPgx())
	if err != nil {
		fmt.Fprintln(out, "reset-admin: database:", err)
		return 1
	}
	defer pool.Close()
	if err := dbmigrate.WaitFor(ctx, pool, dbmigrate.Required, 30*time.Second); err != nil {
		fmt.Fprintln(out, "reset-admin: database schema:", err)
		return 1
	}
	auditStore := audit.NewPostgresStore(pool, audit.ServiceAuth)
	created, err := recoverAccount(ctx, repository.New(pool), auditStore, *email, cfg.DefaultAdminPassword, cfg.PasswordHashIterations)
	if err != nil {
		fmt.Fprintln(out, "reset-admin:", err)
		return 1
	}
	what := "recovered"
	if created {
		what = "created"
	}
	fmt.Fprintf(out, "reset-admin: %s %s — role Admin, locks cleared, sessions ended.\n", what, *email)
	fmt.Fprintln(out, "Sign in with the password in DEFAULT_ADMIN_PASSWORD (the install notes print the command that reads it), then change it.")
	return 0
}

// recoverAccount gives the account the password and the Admin role, clears its locks and ends its sessions, or creates
// it, and records user.account.recover. It reports whether it created the account.
func recoverAccount(ctx context.Context, store recoveryStore, auditStore audit.Writer, email, password string, iterations int) (bool, error) {
	role, err := store.GetRoleByName(ctx, "Admin")
	if err != nil || role == nil {
		return false, fmt.Errorf("no Admin role: %v", err)
	}
	hash, err := security.HashPassword(password, iterations)
	if err != nil {
		return false, err
	}
	rec := audit.Record{Service: audit.ServiceAuth, Action: actionAccountRecover, ActorUserID: "system", ActorEmail: "reset-admin",
		TargetType: "user", TargetEmail: email}

	user, err := store.GetUserByEmail(ctx, email)
	if err != nil {
		return false, err
	}
	created := user == nil
	if created {
		now := time.Now().UTC()
		user = &model.User{ID: uuid.New().String(), Name: "admin", Email: email, RoleID: role.ID, RoleName: role.Name,
			PasswordHash: hash, AuthSource: model.AuthSourcePassword, CreatedAt: now, UpdatedAt: now}
		err = store.CreateUser(ctx, user)
	} else {
		rec.Before, _ = json.Marshal(map[string]any{"role": user.RoleName, "locked": user.LockedUntil != nil || user.DormantLockedAt != nil})
		err = errors.Join(
			store.UpdateUserPassword(ctx, user.ID, hash),
			roleChange(ctx, store, user, role.ID),
			unlock(ctx, store, user.ID),
			store.BumpTokenVersion(ctx, user.ID),
		)
	}
	rec.TargetID = user.ID
	rec.After, _ = json.Marshal(map[string]any{"role": role.Name, "created": created})
	if err != nil {
		rec.Result, rec.Error = audit.ResultFailure, err.Error()
	}
	if _, werr := auditStore.Write(ctx, rec); werr != nil {
		err = errors.Join(err, fmt.Errorf("audit row: %w", werr))
	}
	return created, err
}

func roleChange(ctx context.Context, store recoveryStore, user *model.User, adminRoleID int) error {
	if user.RoleID == adminRoleID {
		return nil
	}
	return store.UpdateUserRole(ctx, user.ID, adminRoleID)
}

func unlock(ctx context.Context, store recoveryStore, id string) error {
	_, err := store.UnlockUser(ctx, id)
	return err
}
