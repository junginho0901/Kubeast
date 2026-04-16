package audit

import (
	"encoding/json"
	"net/http"
	"strings"
)

// FromHTTPRequest extracts the HTTP context (IP, user-agent, request-id, path)
// into a new Record. Callers fill in Service, Action, Actor, Target, etc.
func FromHTTPRequest(r *http.Request) Record {
	ip := r.Header.Get("X-Forwarded-For")
	if ip == "" {
		ip = r.RemoteAddr
	} else if i := strings.IndexByte(ip, ','); i > 0 {
		ip = ip[:i]
	}
	return Record{
		RequestIP: strings.TrimSpace(ip),
		UserAgent: r.Header.Get("User-Agent"),
		RequestID: r.Header.Get("X-Request-ID"),
		Path:      r.URL.Path,
	}
}

// sensitiveKeys lists JSON field names whose values must be redacted
// before persistence. Matching is case-insensitive and substring-based
// so both "password" and "db_password" are masked.
var sensitiveKeys = []string{
	"password",
	"passwd",
	"secret",
	"token",
	"apikey",
	"api_key",
	"privatekey",
	"private_key",
	"authorization",
}

// MaskSensitive walks a JSON value (object/array) and replaces the values
// of any field whose (lower-cased) key contains a sensitiveKeys entry
// with the string "***". Non-JSON input is returned unchanged.
//
// Use this before assigning to Record.Before / Record.After whenever the
// payload might contain user-supplied secrets.
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
	lower := strings.ToLower(key)
	for _, k := range sensitiveKeys {
		if strings.Contains(lower, k) {
			return true
		}
	}
	return false
}
