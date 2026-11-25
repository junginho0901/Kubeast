package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// keptFor are two tokens whose identity in a cluster is the same whatever namespaces their grant there is limited to: a
// person with a custom role, and the alert investigator.
var keptFor = map[string]func(namespaces ...string) TokenPayload{
	"a person": func(namespaces ...string) TokenPayload {
		return limitedOn("c", TokenPayload{UserID: "u1", Email: "a@example.com", Roles: map[string]string{"c": "team"}}, namespaces)
	},
	"the investigator": func(namespaces ...string) TokenPayload {
		return limitedOn("c", TokenPayload{UserID: "system", Email: UserInvestigator, System: SystemInvestigator}, namespaces)
	},
}

func limitedOn(cluster string, p TokenPayload, namespaces []string) TokenPayload {
	if len(namespaces) > 0 {
		p.Namespaces = map[string][]string{cluster: namespaces}
	}
	return p
}

// What is kept for a caller is kept for the namespaces its grant is limited to: an answer may hold those alone, so a
// token of the same identity limited to others, or to none, has another key.
func TestCacheIdentityHoldsTheNamespacesOfTheGrant(t *testing.T) {
	for name, token := range keptFor {
		t.Run(name, func(t *testing.T) {
			seen := map[string][]string{}
			for _, namespaces := range [][]string{nil, {"a"}, {"b"}, {"a", "b"}, {"a", "b", "c"}, {strings.Repeat("a", 63), strings.Repeat("b", 63)}} {
				key := token(namespaces...).CacheIdentity("c")
				if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(key) {
					t.Errorf("a grant of %v: the key is %q, want 16 hex digits", namespaces, key)
				}
				if other, dup := seen[key]; dup {
					t.Errorf("a grant of %v and one of %v share a key", other, namespaces)
				}
				seen[key] = namespaces
			}
			given := []string{"b", "a"}
			if token(given...).CacheIdentity("c") != token("a", "b").CacheIdentity("c") {
				t.Error("one grant has two keys by the order of its namespaces")
			}
			if !slices.Equal(given, []string{"b", "a"}) {
				t.Errorf("the token's namespaces were put in another order: %v", given)
			}
		})
	}
}

// The rest of the key is as it was: a grant of the whole cluster, also one limited on another cluster only, has the hash
// of its user and groups, and the user, the groups and the cluster's own grant tell two keys apart.
func TestCacheIdentityOfAWholeGrantIsItsUserAndGroups(t *testing.T) {
	hash := func(s string) string {
		sum := sha256.Sum256([]byte(s))
		return hex.EncodeToString(sum[:8])
	}
	person := keptFor["a person"]()
	for name, tc := range map[string]struct {
		token TokenPayload
		want  string
	}{
		"a person":                   {person, "a@example.com|kubeast:authenticated,kubeast:role:team"},
		"the investigator":           {keptFor["the investigator"](), "kubeast:investigator|kubeast:investigator"},
		"limited on another cluster": {limitedOn("d", person, []string{"a"}), "a@example.com|kubeast:authenticated,kubeast:role:team"},
		"an empty list":              {TokenPayload{Email: "a@example.com", Roles: person.Roles, Namespaces: map[string][]string{"c": {}}}, "a@example.com|kubeast:authenticated,kubeast:role:team"},
	} {
		if got := tc.token.CacheIdentity("c"); got != hash(tc.want) {
			t.Errorf("%s: %s, want the hash of %q", name, got, tc.want)
		}
	}
	limited := keptFor["a person"]("a")
	for name, change := range map[string]func(*TokenPayload){
		"user":  func(p *TokenPayload) { p.Email = "b@example.com" },
		"group": func(p *TokenPayload) { p.Roles = map[string]string{"c": "other"} },
	} {
		p := limited
		change(&p)
		if p.CacheIdentity("c") == limited.CacheIdentity("c") {
			t.Errorf("another %s has the same key", name)
		}
	}
}
