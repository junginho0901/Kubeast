package security

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// readLike is a list the size of the Read role's (menus, resource reads, 40-odd AI read tools).
func readLike(prefix string) []string {
	out := []string{"menu.dashboard", "menu.workloads", "resource.*.read", "resource.helm.read", "ai.mcp.use"}
	for i := 0; i < 50; i++ {
		out = append(out, fmt.Sprintf("ai.tool.%sread_tool_%02d", prefix, i))
	}
	return out
}

func TestToken_OneRoleOnManyClustersStaysUnderTheCookieLimit(t *testing.T) {
	m, err := NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	perms, roles := auth.PermissionMatrix{}, map[string]string{}
	for i := 0; i < 8; i++ {
		id := fmt.Sprintf("cluster-%d", i)
		perms[id], roles[id] = readLike(""), "Read"
	}
	tok, err := m.CreateToken("u1", "read@example.com", "Member", perms, roles, nil, 1)
	if err != nil {
		t.Fatalf("Read on 8 clusters: %v", err)
	}
	if len(tok) > MaxTokenBytes {
		t.Fatalf("token %d bytes", len(tok))
	}
	claims, err := m.ValidateToken(tok)
	if err != nil {
		t.Fatal(err)
	}
	got := auth.ParsePermissions(claims["permissions"])
	for id, want := range perms {
		if strings.Join(got[id], ",") != strings.Join(want, ",") {
			t.Fatalf("%s lost its permissions: %v", id, got[id])
		}
	}
}

func TestToken_TooLargeIsRefusedNotIssued(t *testing.T) {
	m, err := NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	perms := auth.PermissionMatrix{}
	for i := 0; i < 8; i++ { // a different list on every cluster: nothing to share
		perms[fmt.Sprintf("cluster-%d", i)] = readLike(fmt.Sprintf("c%d_", i))
	}
	if _, err := m.CreateToken("u1", "x@example.com", "Member", perms, nil, nil, 1); !errors.Is(err, ErrTokenTooLarge) {
		t.Fatalf("want ErrTokenTooLarge, got %v", err)
	}
}
