package auth

import (
	"errors"
	"io"
	"net/http"
	"strconv"
)

// A token is checked against what auth-service stores: the user's token_version, the signed-out sign-ins and the API
// key the token was exchanged for. A check that could not read them is neither a pass nor a verdict. The token is
// refused all the same, never taken on trust, but with 503 and Retry-After (RFC 9110 §15.6.4, §10.2.3) rather than
// 401 (§15.5.2), which the console reads as the end of the sign-in: a database that restarts signs nobody out.

// ErrSessionUnreadable is a check of a token's session that could not read what it is checked against.
var ErrSessionUnreadable = errors.New("session could not be checked")

// SessionUnreadableRetryAfter is the Retry-After, in seconds, of the answer RefuseSessionUnreadable writes.
const SessionUnreadableRetryAfter = 5

// ReadFailed reports whether err, a VersionLookup's or a read of a session's state, is a read that failed rather than
// a verdict: every error but ErrSubjectGone, which says the user or the API key is gone.
func ReadFailed(err error) bool {
	return err != nil && !errors.Is(err, ErrSubjectGone)
}

// RefuseSessionUnreadable answers a request whose session could not be checked: 503, to be asked again.
func RefuseSessionUnreadable(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", strconv.Itoa(SessionUnreadableRetryAfter))
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = io.WriteString(w, `{"detail":"Session could not be checked; try again"}`+"\n")
}
