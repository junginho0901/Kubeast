package handler

import (
	"fmt"
	"unicode/utf8"
)

// The longest names the screens and the API take, counted in characters as the screens' fields count them: a name a
// person reads (a cluster's display name, a role, a team) and a person's name, as Keycloak's default user profile holds
// a first or last name. An API key's name keeps its own 64 (apiKeyNameMax).
const (
	nameMax     = 100
	userNameMax = 255
)

// nameTooLong is the 400's text for a name past its limit, or "" when it is within it.
func nameTooLong(field, value string, max int) string {
	if utf8.RuneCountInString(value) > max {
		return fmt.Sprintf("%s: up to %d characters", field, max)
	}
	return ""
}
