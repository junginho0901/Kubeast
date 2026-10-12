package handler

import (
	"reflect"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func TestNormalizeNamespaces(t *testing.T) {
	got, err := normalizeNamespaces([]string{" web ", "api", "web", ""})
	if err != nil || !reflect.DeepEqual(got, []string{"api", "web"}) {
		t.Fatalf("trim, dedupe, sort: %v %v", got, err)
	}
	if got, err := normalizeNamespaces(nil); err != nil || got != nil {
		t.Fatalf("empty means the whole cluster: %v %v", got, err)
	}
	for _, bad := range []string{"Web", "a_b", "-a", "a-", strings.Repeat("a", 64), "a b"} {
		if _, err := normalizeNamespaces([]string{bad}); err == nil {
			t.Fatalf("%q must be refused", bad)
		}
	}
	many := make([]string, maxGrantNamespaces+1)
	for i := range many {
		many[i] = "ns" + strings.Repeat("a", i%5) + string(rune('a'+i%26)) + string(rune('a'+(i/26)%26))
	}
	if _, err := normalizeNamespaces(many); err == nil || !strings.Contains(err.Error(), "at most") {
		t.Fatalf("more than %d must be refused: %v", maxGrantNamespaces, err)
	}
}

func TestMissingNamespaces_Ceiling(t *testing.T) {
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"admin.users.update", "resource.*.read"}}, Namespaces: map[string][]string{"c": {"api", "web"}}}
	if m := missingNamespaces(scoped, "c", []string{"web"}); m != nil {
		t.Fatalf("within own scope: %v", m)
	}
	if m := missingNamespaces(scoped, "c", []string{"web", "db"}); !reflect.DeepEqual(m, []string{"db"}) {
		t.Fatalf("beyond own scope: %v", m)
	}
	if m := missingNamespaces(scoped, "c", nil); !reflect.DeepEqual(m, []string{"*"}) {
		t.Fatalf("the whole cluster from a scoped grant: %v", m)
	}
	if !strings.Contains(ceilingNamespacesError([]string{"*"}).Error(), "whole cluster") || !strings.Contains(ceilingNamespacesError([]string{"db"}).Error(), "db") {
		t.Fatal("the refusal names what is missing")
	}
	unscoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"admin.users.update"}}}
	admin := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"*"}}}
	for _, p := range []auth.TokenPayload{unscoped, admin} {
		if missingNamespaces(p, "c", nil) != nil || missingNamespaces(p, "c", []string{"db"}) != nil {
			t.Fatal("an unscoped grantor is not limited")
		}
	}
}

func TestRequestWithinGrant(t *testing.T) {
	whole := &repository.UserClusterGrant{ClusterID: "c", Role: "Read"}
	scoped := &repository.UserClusterGrant{ClusterID: "c", Role: "Read", Namespaces: []string{"api", "web"}}
	if requestWithinGrant(whole, nil) != nil || requestWithinGrant(whole, []string{"db"}) != nil || requestWithinGrant(nil, nil) != nil {
		t.Fatal("an unscoped grant may request anything")
	}
	if requestWithinGrant(scoped, []string{"web"}) != nil {
		t.Fatal("within the scope")
	}
	if err := requestWithinGrant(scoped, nil); err == nil || !strings.Contains(err.Error(), "limited to namespaces") {
		t.Fatalf("a scoped grant may not request the whole cluster: %v", err)
	}
	if err := requestWithinGrant(scoped, []string{"web", "db"}); err == nil || !strings.Contains(err.Error(), `"db"`) {
		t.Fatalf("outside the scope: %v", err)
	}
	in := accessRequestInput{ClusterID: "c", Role: "Write", DurationMinutes: 30, Reason: "x", Namespaces: []string{"Bad Name"}}
	if err := validateAccessRequestInput(in, testAccessCfg); err == nil || !strings.Contains(err.Error(), "invalid namespace") {
		t.Fatalf("request validation covers namespaces: %v", err)
	}
}
