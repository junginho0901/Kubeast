package auth

import (
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

const userPrefixForTest = "kubeast:user:"

func writerOn(cluster string) TokenPayload {
	return TokenPayload{UserID: "u1", Email: "a@example.com", Roles: map[string]string{cluster: "Write"}}
}

// With no prefix set, the upgrade changes nothing: the user name stays the mail address a User binding names.
func TestImpersonation_WithoutAPrefixTheUserIsTheAddress(t *testing.T) {
	t.Setenv("IMPERSONATION_USER_PREFIX", "")
	if user, _ := writerOn("c").Impersonation("c"); user != "a@example.com" {
		t.Errorf("user = %q", user)
	}
}

// A chosen prefix changes the name a cluster sees and no group, so a binding of a group goes on working.
func TestImpersonation_APrefixChangesTheUserAndNoGroup(t *testing.T) {
	cases := []TokenPayload{
		writerOn("c"),
		{Email: "a@example.com", Roles: map[string]string{"c": "Read"}},
		{Email: "a@example.com", Roles: map[string]string{"c": "Admin"}},
		{Email: "a@example.com", Roles: map[string]string{"c": "SRE On Call"}},
		{Email: "a@example.com", Roles: map[string]string{"c": "Write"}, Namespaces: map[string][]string{"c": {"shop"}}},
		{Email: "root@example.com", Perms: PermissionMatrix{"*": {"*"}}},
		{Email: "a@example.com"},
	}
	for _, payload := range cases {
		t.Setenv("IMPERSONATION_USER_PREFIX", "")
		address, groupsBefore := payload.Impersonation("c")
		t.Setenv("IMPERSONATION_USER_PREFIX", userPrefixForTest)
		user, groups := payload.Impersonation("c")
		if user != userPrefixForTest+address {
			t.Errorf("%+v: user = %q, want the prefix before %q", payload, user, address)
		}
		if !reflect.DeepEqual(groups, groupsBefore) {
			t.Errorf("%+v: groups %v, were %v", payload, groups, groupsBefore)
		}
	}
}

// What a cluster sees through every path is the same name: the access line, the cache key and the request's headers.
func TestImpersonation_APrefixReachesWhatIsBuiltFromIt(t *testing.T) {
	t.Setenv("IMPERSONATION_USER_PREFIX", userPrefixForTest)
	if access := writerOn("c").Access("c", true); access.User != userPrefixForTest+"a@example.com" {
		t.Errorf("access user = %q", access.User)
	}
	withPrefix := writerOn("c").CacheIdentity("c")
	t.Setenv("IMPERSONATION_USER_PREFIX", "")
	if without := writerOn("c").CacheIdentity("c"); withPrefix == without {
		t.Error("a cached answer's key does not follow the name the cluster decides for")
	}
}

// The investigator is Kubeast's own identity: its binding names it, whatever people are called.
func TestImpersonation_APrefixLeavesTheInvestigator(t *testing.T) {
	t.Setenv("IMPERSONATION_USER_PREFIX", userPrefixForTest)
	user, groups := TokenPayload{System: SystemInvestigator}.Impersonation("c")
	if user != UserInvestigator || !reflect.DeepEqual(groups, []string{GroupInvestigator}) {
		t.Errorf("user %q groups %v", user, groups)
	}
}

// The value is the chart's to hand over, off by default: another name would leave the switch doing nothing with no test failing.
func TestChartSetsImpersonationUserPrefixOffByDefault(t *testing.T) {
	raw, err := os.ReadFile("../../../helm/kubeast/templates/configmap.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^\s*IMPERSONATION_USER_PREFIX: `).Match(raw) {
		t.Error("templates/configmap.yaml does not set IMPERSONATION_USER_PREFIX")
	}
	values, err := os.ReadFile("../../../helm/kubeast/values.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(values), `userPrefix: ""`) {
		t.Error(`values.yaml does not leave auth.impersonation.userPrefix empty`)
	}
}
