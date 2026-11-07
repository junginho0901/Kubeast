package response

import (
	"log/slog"
	"regexp"
)

// upstreamUnreachable stands in for a failed call in what a caller reads.
const upstreamUnreachable = "server unreachable"

// failedCall matches the text of a failed outbound call as Go writes it: net/url's `Get "http://host/path": dial tcp
// 10.0.0.1:80: …`, or the dial or lookup alone. Also when an error on the way flattened it to text with %v.
var failedCall = regexp.MustCompile(`(?:Get|Post|Put|Patch|Delete|Head|Options) "[a-z][a-z0-9+.-]*://[^"]*":.*|(?:dial (?:tcp|udp)|lookup) .*`)

// Public is err as a caller may read it: what failed stays, the internal address it failed at does not (OWASP Error
// Handling: generic response, details logged server side). The whole error goes to the log.
func Public(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	public := failedCall.ReplaceAllString(msg, upstreamUnreachable)
	if public != msg {
		slog.Warn("upstream call failed", "err", msg)
	}
	return public
}
