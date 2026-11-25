package handler

import (
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

// A provider's sign-in takes over only an account the sign-up form made that is still a password account and waits
// for approval or holds no password. An account an admin made stays a password account whatever its role or password,
// and so does the chart's admin account (the account stored under admin.email as written), the way in while the
// provider is down.
func TestSelfSignUpToMoveNamesOnlyASelfSignUpTheProviderTakesOver(t *testing.T) {
	cfg := config.Config{DefaultAdminEmail: "ops@example.com"}
	for _, c := range []struct {
		name string
		user model.User
		want bool
	}{
		{"a self sign-up waiting with its password", model.User{Email: "a@example.com", SelfSignedUp: true, AuthSource: model.AuthSourcePassword, RoleName: "Pending", PasswordHash: "h"}, true},
		{"a self sign-up waiting with no password", model.User{Email: "a@example.com", SelfSignedUp: true, AuthSource: model.AuthSourcePassword, RoleName: "Pending"}, true},
		{"a self sign-up approved holding no password", model.User{Email: "a@example.com", SelfSignedUp: true, AuthSource: model.AuthSourcePassword, RoleName: "Member"}, true},
		{"a self sign-up approved with its password", model.User{Email: "a@example.com", SelfSignedUp: true, AuthSource: model.AuthSourcePassword, RoleName: "Member", PasswordHash: "h"}, false},
		{"a self sign-up taken over already", model.User{Email: "a@example.com", SelfSignedUp: true, AuthSource: model.AuthSourceOIDC, RoleName: "Pending"}, false},
		{"an account an admin made, Pending with a password", model.User{Email: "a@example.com", AuthSource: model.AuthSourcePassword, RoleName: "Pending", PasswordHash: "h"}, false},
		{"an account an admin made, holding no password", model.User{Email: "a@example.com", AuthSource: model.AuthSourcePassword, RoleName: "Member"}, false},
		{"the chart's admin account as a waiting self sign-up", model.User{Email: "ops@example.com", SelfSignedUp: true, AuthSource: model.AuthSourcePassword, RoleName: "Pending", PasswordHash: "h"}, false},
		{"its address in other letters", model.User{Email: "Ops@Example.com", SelfSignedUp: true, AuthSource: model.AuthSourcePassword, RoleName: "Pending", PasswordHash: "h"}, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := selfSignUpToMove(cfg, &c.user); got != c.want {
				t.Errorf("selfSignUpToMove = %v, want %v", got, c.want)
			}
		})
	}
}
