package audit

import (
	"encoding/json"
	"strings"
)

// readableAfter is a stored after as a reader gets it. A Helm upgrade row written before the values were kept out of
// the row holds their whole text; the hash chain seals the row, so it is masked here, on the way to the screen, the CSV
// and the AI's audit tool. The chain and the sinks read the table with their own queries.
func readableAfter(action string, after []byte) json.RawMessage {
	if action != "helm.release.upgrade" {
		return after
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(after, &fields); err != nil {
		return after
	}
	if _, stored := fields["values"]; !stored {
		return after
	}
	fields["values"] = json.RawMessage(`"***"`)
	masked, err := json.Marshal(fields)
	if err != nil {
		return after
	}
	return masked
}

const invalidValueMark = "Invalid value: "

// MaskInvalidValues takes the refused values out of an API server's error, leaving the field and what was wrong: it
// quotes what the caller sent, which may be a secret (`spec.x: Invalid value: "...": must be …`).
func MaskInvalidValues(msg string) string {
	var out strings.Builder
	for {
		i := strings.Index(msg, invalidValueMark)
		if i < 0 {
			out.WriteString(msg)
			return out.String()
		}
		i += len(invalidValueMark)
		out.WriteString(msg[:i])
		msg = msg[i:]
		end, quoted := invalidValueEnd(msg)
		if quoted {
			out.WriteString(`"***"`)
		} else {
			out.WriteString("***")
		}
		msg = msg[end:]
	}
}

// invalidValueEnd finds where the value at the start of s ends: a quoted string, or anything up to a ": " outside
// braces and quotes (a Go struct printed by %#v).
func invalidValueEnd(s string) (end int, quoted bool) {
	if strings.HasPrefix(s, `"`) {
		for i := 1; i < len(s); i++ {
			switch s[i] {
			case '\\':
				i++
			case '"':
				return i + 1, true
			}
		}
		return len(s), true
	}
	depth, inQuotes := 0, false
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case inQuotes && c == '\\':
			i++
		case c == '"':
			inQuotes = !inQuotes
		case inQuotes:
		case c == '{' || c == '[' || c == '(':
			depth++
		case c == '}' || c == ']' || c == ')':
			depth--
		case c == ':' && depth <= 0 && i+1 < len(s) && s[i+1] == ' ':
			return i, false
		}
	}
	return len(s), false
}
