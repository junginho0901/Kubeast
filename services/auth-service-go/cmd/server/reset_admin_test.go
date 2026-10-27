package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

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

func TestRecoverAccount_LockedDemotedAdminGetsBack(t *testing.T) {
	locked := time.Now().Add(time.Hour)
	store := &fakeRecovery{users: map[string]*model.User{"admin": {ID: "u1", Email: "admin", RoleID: 2, RoleName: "Member", LockedUntil: &locked}}}
	rows := &fakeAudit{}
	created, err := recoverAccount(context.Background(), store, rows, "admin", "the-secret-value", 1000)
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
	created, err := recoverAccount(context.Background(), store, rows, "admin", "the-secret-value", 1000)
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
	if _, err := recoverAccount(context.Background(), store, rows, "admin", "x-value", 1000); err == nil {
		t.Fatal("want the error")
	}
	if len(rows.rows) != 1 || rows.rows[0].Result != audit.ResultFailure {
		t.Fatalf("audit %+v", rows.rows)
	}
}
