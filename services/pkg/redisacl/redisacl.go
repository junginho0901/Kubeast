// Package redisacl reads the chart's Redis users (helm/kubeast/templates/_helpers.tpl, kubeast.redisUsersAcl) for the
// services' tests. A service's test records the commands its code sends and holds them to the commands its user may
// run, so a command the code starts to send that the user's line lacks fails in go test; in an install with redis.acl
// Redis would refuse it (NOPERM) and the cache would read empty without an error.
package redisacl

import (
	"fmt"
	"os"
	"strings"
)

// SignIn is what a client sends on connect that no user's rule decides: AUTH and HELLO sign in and take no rule, and
// go-redis's CLIENT SETINFO and CLIENT MAINT_NOTIFICATIONS are refused, which go-redis ignores.
var SignIn = []string{"AUTH", "HELLO", "CLIENT"}

// Commands returns the commands the chart's Redis user may run, upper case, from its one `user <name> …` line in the
// chart helpers at helpersPath. A category (+@read) or a key or channel rule names no command and is not read.
func Commands(helpersPath, user string) (map[string]bool, error) {
	text, err := os.ReadFile(helpersPath)
	if err != nil {
		return nil, err
	}
	var line string
	for _, l := range strings.Split(string(text), "\n") {
		l = strings.TrimSpace(l)
		if !strings.HasPrefix(l, "user "+user+" ") {
			continue
		}
		if line != "" {
			return nil, fmt.Errorf("%s: more than one line for the Redis user %s", helpersPath, user)
		}
		line = l
	}
	if line == "" {
		return nil, fmt.Errorf("%s: no line for the Redis user %s", helpersPath, user)
	}
	allowed := map[string]bool{}
	for _, rule := range strings.Fields(line) {
		if !strings.HasPrefix(rule, "+") {
			continue
		}
		if strings.HasPrefix(rule, "+@") {
			return nil, fmt.Errorf("%s: the Redis user %s allows the category %s, which names no command to compare", helpersPath, user, rule)
		}
		name, _, _ := strings.Cut(strings.TrimPrefix(rule, "+"), "|")
		allowed[strings.ToUpper(name)] = true
	}
	return allowed, nil
}

// Refused returns the commands of sent that neither allowed nor SignIn holds, each once, in the order first sent.
func Refused(sent []string, allowed map[string]bool) []string {
	seen := map[string]bool{}
	for _, c := range SignIn {
		seen[c] = true
	}
	var refused []string
	for _, c := range sent {
		c = strings.ToUpper(c)
		if seen[c] || allowed[c] {
			continue
		}
		seen[c] = true
		refused = append(refused, c)
	}
	return refused
}
