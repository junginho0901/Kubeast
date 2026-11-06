package handler

import (
	"errors"
	"strings"
	"unicode"
)

// errAccountName refuses a name for a new account. An account's address is the
// user name a cluster sees (auth.TokenPayload.Impersonation, which trims it):
// spaces around an address would be that address there, whoever holds it, and
// Kubernetes, the platforms and Kubeast itself keep the names with a colon
// (system:, eks:, kubeast:) for their own users, which clusters bind directly.
var errAccountName = errors.New("this name cannot be a Kubernetes user: an account name may not contain a colon, a space or a control character")

// checkAccountName is for an account about to be made; one that exists keeps its
// name and still signs in.
func checkAccountName(name string) error {
	if strings.ContainsRune(name, ':') {
		return errAccountName
	}
	for _, r := range name {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return errAccountName
		}
	}
	return nil
}
