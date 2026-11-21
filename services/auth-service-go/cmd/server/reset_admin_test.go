package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/audit"
)

type fakeRecovery struct {
	users                   map[string]*model.User
	roles, unlocked, bumped []string
	failPassword            error
	created                 *model.User
}

func (f *fakeRecovery) GetUserByEmail(_ context.Context, email string) (*model.User, error) {
	return f.users[email], nil
}
func (f *fakeRecovery) GetRoleByName(_ context.Context, name string) (*model.RoleWithPermissions, error) {
	return &model.RoleWithPermissions{Role: model.Role{ID: 1, Name: name}}, nil
}
func (f *fakeRecovery) CreateUser(_ context.Context, u *model.User) error { f.created = u; return nil }
func (f *fakeRecovery) UpdateUserPassword(_ context.Context, id, hash string) error {
	if f.failPassword != nil {
		return f.failPassword
	}
	for _, u := range f.users {
		if u.ID == id {
			u.PasswordHash = hash
		}
	}
	return nil
}
func (f *fakeRecovery) UpdateUserRole(_ context.Context, id string, _ int) error {
	f.roles = append(f.roles, id)
	return nil
}
func (f *fakeRecovery) UnlockUser(_ context.Context, id string) (bool, error) {
	f.unlocked = append(f.unlocked, id)
	return true, nil
}
func (f *fakeRecovery) BumpTokenVersion(_ context.Context, id string) error {
	f.bumped = append(f.bumped, id)
	return nil
}

type fakeAudit struct{ rows []audit.Record }

func (a *fakeAudit) Write(_ context.Context, rec audit.Record) (int64, error) {
	a.rows = append(a.rows, rec)
	return 1, nil
}

// recoveryConfig is reset-admin's settings: the chart's admin account is "admin" and the Secret holds password.
func recoveryConfig(password string) config.Config {
	return config.Config{DefaultAdminEmail: "admin", DefaultAdminPassword: password, PasswordHashIterations: 1000}
}

func TestRecoverAccount_LockedDemotedAdminGetsBack(t *testing.T) {
	locked := time.Now().Add(time.Hour)
	store := &fakeRecovery{users: map[string]*model.User{"admin": {ID: "u1", Email: "admin", RoleID: 2, RoleName: "Member", LockedUntil: &locked}}}
	rows := &fakeAudit{}
	_, created, err := recoverAccount(context.Background(), store, rows, recoveryConfig("the-secret-value"), "admin")
	if err != nil || created {
		t.Fatalf("created %v err %v", created, err)
	}
	if !security.VerifyPassword("the-secret-value", store.users["admin"].PasswordHash) {
		t.Fatal("the password is not the Secret's value")
	}
	if len(store.roles) != 1 || len(store.unlocked) != 1 || len(store.bumped) != 1 {
		t.Fatalf("role %v unlock %v sessions %v, want one each", store.roles, store.unlocked, store.bumped)
	}
	if len(rows.rows) != 1 || rows.rows[0].Action != "user.account.recover" || rows.rows[0].Result == audit.ResultFailure || rows.rows[0].TargetID != "u1" {
		t.Fatalf("audit %+v", rows.rows)
	}
	var before map[string]any
	_ = json.Unmarshal(rows.rows[0].Before, &before)
	if before["role"] != "Member" || before["locked"] != true {
		t.Fatalf("before %v", before)
	}
}

func TestRecoverAccount_MissingAccountIsCreated(t *testing.T) {
	store := &fakeRecovery{users: map[string]*model.User{}}
	rows := &fakeAudit{}
	_, created, err := recoverAccount(context.Background(), store, rows, recoveryConfig("the-secret-value"), "admin")
	if err != nil || !created || store.created == nil || store.created.RoleName != "Admin" || store.created.Email != "admin" {
		t.Fatalf("created %v %+v err %v", created, store.created, err)
	}
	if len(rows.rows) != 1 || rows.rows[0].TargetID != store.created.ID {
		t.Fatalf("audit %+v", rows.rows)
	}
}

func TestRecoverAccount_AFailureIsRecorded(t *testing.T) {
	store := &fakeRecovery{users: map[string]*model.User{"admin": {ID: "u1", Email: "admin", RoleID: 1, RoleName: "Admin"}}, failPassword: errors.New("db down")}
	rows := &fakeAudit{}
	if _, _, err := recoverAccount(context.Background(), store, rows, recoveryConfig("x-value"), "admin"); err == nil {
		t.Fatal("want the error")
	}
	if len(rows.rows) != 1 || rows.rows[0].Result != audit.ResultFailure {
		t.Fatalf("audit %+v", rows.rows)
	}
}

// reset-admin gives a password only to an account the password form opens, and its last line says how the account it
// recovered signs in: the password form refuses an account the provider made unless it is the chart's admin account —
// the account stored under admin.email as written, not one whose address differs from it only in letter case — so
// that one gets no password and is told to sign in through the provider. The chart's admin account the provider made
// is told how to change the password, which the Account page does not offer it.
func TestResetAdminTellsAnAccountTheProviderMadeToSignInThroughIt(t *testing.T) {
	const passwordLine = "Sign in with the password in DEFAULT_ADMIN_PASSWORD"
	for _, c := range []struct {
		name, admin, email, source string
		password                   bool
		change                     string // how the line says to change the password, when it gives one
	}{
		{"an account the provider made", "ops@example.com", "alice@example.com", model.AuthSourceOIDC, false, ""},
		{"the chart's admin account the provider made", "ops@example.com", "ops@example.com", model.AuthSourceOIDC, true, "POST /api/v1/auth/change-password"},
		{"an account the provider made under admin.email in other letters", "Ops@Example.com", "ops@example.com", model.AuthSourceOIDC, false, ""},
		{"a password account", "ops@example.com", "bob@example.com", model.AuthSourcePassword, true, ", then change it."},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg := config.Config{DefaultAdminEmail: c.admin, DefaultAdminPassword: "the-secret-value", PasswordHashIterations: 1000}
			store := &fakeRecovery{users: map[string]*model.User{c.email: {ID: "u1", Email: c.email, RoleID: 2, RoleName: "Member", AuthSource: c.source}}}
			rows := &fakeAudit{}
			user, created, err := recoverAccount(context.Background(), store, rows, cfg, c.email)
			if err != nil || created || user == nil || user.ID != "u1" {
				t.Fatalf("user %+v created %v err %v, want the stored account", user, created, err)
			}
			if got := store.users[c.email].PasswordHash != ""; got != c.password {
				t.Errorf("a password was written = %v, want %v", got, c.password)
			}
			if len(store.roles) != 1 || len(store.unlocked) != 1 || len(store.bumped) != 1 {
				t.Errorf("role %v unlock %v sessions %v, want one each", store.roles, store.unlocked, store.bumped)
			}
			var after map[string]any
			if len(rows.rows) != 1 || json.Unmarshal(rows.rows[0].After, &after) != nil || after["password_set"] != c.password {
				t.Errorf("audit %+v, want one row with password_set %v", rows.rows, c.password)
			}
			line := signInLine(cfg, user)
			if got := strings.HasPrefix(line, passwordLine); got != c.password {
				t.Errorf("%q: tells to sign in with the password = %v, want %v", line, got, c.password)
			}
			if c.password && !strings.Contains(line, c.change) {
				t.Errorf("%q: does not say %q", line, c.change)
			}
			if c.source == model.AuthSourceOIDC && strings.Contains(line, "then change it") {
				t.Errorf("%q: tells an account the provider made to change the password where the Account page does not offer it", line)
			}
			if !c.password && (!strings.Contains(line, "single sign-on") || !strings.Contains(line, "without --email")) {
				t.Errorf("%q: does not say to sign in through the provider and how to recover the chart's admin account", line)
			}
		})
	}
	t.Run("an account it created", func(t *testing.T) {
		cfg := config.Config{DefaultAdminEmail: "ops@example.com", DefaultAdminPassword: "the-secret-value", PasswordHashIterations: 1000}
		store := &fakeRecovery{users: map[string]*model.User{}}
		user, created, err := recoverAccount(context.Background(), store, &fakeAudit{}, cfg, "carol@example.com")
		if err != nil || !created || user == nil {
			t.Fatalf("user %+v created %v err %v", user, created, err)
		}
		if line := signInLine(cfg, user); !strings.HasPrefix(line, passwordLine) {
			t.Errorf("%q, want the password line", line)
		}
	})
}
