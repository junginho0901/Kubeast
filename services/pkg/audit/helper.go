package audit

import (
	"encoding/json"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strings"
)

// FromHTTPRequest extracts the HTTP context (IP, user-agent, request-id, path)
// into a new Record. Callers fill in Service, Action, Actor, Target, etc.
//
// The client address is what the gateway saw: nginx sets X-Real-IP from its
// own peer (after ngx_http_realip_module walks the proxies it was told to
// trust, see gateway.trustedProxies). X-Forwarded-For is never read — any
// client can put anything there and the gateway only appends to it.
// Without X-Real-IP (a direct in-cluster call) the peer address is used.
func FromHTTPRequest(r *http.Request) Record {
	return Record{
		RequestIP: ClientIP(r),
		UserAgent: r.Header.Get("User-Agent"),
		RequestID: r.Header.Get("X-Request-ID"),
		Path:      r.URL.Path,
	}
}

// ClientIP is the address the gateway attributed the request to (X-Real-IP),
// else the peer address without its port.
func ClientIP(r *http.Request) string {
	if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
		return real
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// sensitiveKeys lists words of JSON field names whose values must be redacted
// before persistence. Case and the separators "_", "-" and "." are ignored and
// the word may sit inside a longer name, so "db_password", "api-key" and
// "accessKey" are all masked. Covers the key names of pkg/redact.
var sensitiveKeys = []string{
	"password",
	"passwd",
	"secret",
	"token",
	"apikey",
	"accesskey",
	"privatekey",
	"credential",
	"connectionstring",
	"authorization",
}

// sensitiveWords count only as a whole word of the name: "fields_names" holds "dsn".
var sensitiveWords = []string{"dsn", "pwd"}

var camelBoundary = regexp.MustCompile(`([a-z0-9])([A-Z])`)

// MaskSensitive walks a JSON value (object/array) and replaces the values
// of any field whose (lower-cased) key contains a sensitiveKeys entry
// with the string "***". Non-JSON input is returned unchanged.
//
// Use this before assigning to Record.Before / Record.After whenever the
// payload might contain user-supplied secrets. It does not look inside a string
// value: YAML or JSON held as text passes through, so keep such text out of the
// record and record its length instead.
func MaskSensitive(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return raw // leave non-JSON payloads untouched
	}
	v = maskValue(v)
	out, err := json.Marshal(v)
	if err != nil {
		return raw
	}
	return out
}

// MustJSON marshals v and returns json.RawMessage. It returns nil on error
// rather than panicking — audit logging is best-effort.
func MustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func maskValue(v any) any {
	switch tv := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(tv))
		for k, inner := range tv {
			if isSensitive(k) {
				out[k] = "***"
			} else {
				out[k] = maskValue(inner)
			}
		}
		return out
	case []any:
		for i := range tv {
			tv[i] = maskValue(tv[i])
		}
		return tv
	default:
		return v
	}
}

func isSensitive(key string) bool {
	snake := strings.ToLower(strings.NewReplacer("-", "_", ".", "_").Replace(camelBoundary.ReplaceAllString(key, "${1}_${2}")))
	joined := strings.ReplaceAll(snake, "_", "")
	for _, k := range sensitiveKeys {
		if strings.Contains(joined, k) {
			return true
		}
	}
	for _, word := range strings.Split(snake, "_") {
		if slices.Contains(sensitiveWords, word) {
			return true
		}
	}
	return false
}
