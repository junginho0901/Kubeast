// Package redact removes credentials (and optionally personal data) from text
// that is about to leave the cluster for a language model: tool results,
// logs, resource YAML, page snapshots. Values are replaced with a placeholder
// that keeps the key name, so the model still sees the structure ("there is a
// password here") without the value.
//
// Two rule families:
//   - key names: a `key: value` / `key=value` / `"key": "value"` line whose key
//     looks like a credential (password, token, api_key, ...) loses its value;
//   - value patterns: AWS keys, private-key blocks, JWTs, credentials inside
//     URLs, Bearer/Basic authorization values.
//
// Secret objects are handled separately and unconditionally: a YAML/JSON
// document with `kind: Secret` loses every value under data/stringData and
// its last-applied-configuration annotation, whether redaction is enabled or
// not. The screen path (UI) is not affected by this package.
//
// The same rules exist in services/ai-service/app/services/redact.py; keep
// the two lists in sync.
package redact

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Options is read from the environment once at startup (FromEnv).
type Options struct {
	// Enabled turns the credential and PII rules on (REDACTION_ENABLED,
	// default true). Secret objects are stripped regardless.
	Enabled bool
	// PII adds the personal-data rules (REDACTION_PII, default false):
	// e-mail, Korean phone and resident registration numbers, card numbers.
	PII bool
	// Disabled lists rule names to skip (REDACTION_DISABLE=a,b): key_name,
	// private_key, url_credentials, authorization, jwt, aws_key, email, phone,
	// rrn, card.
	Disabled map[string]bool
}

// Stats says what was replaced, for the audit row.
type Stats struct {
	Count int            `json:"count"`
	Kinds map[string]int `json:"kinds,omitempty"`
}

func (s *Stats) add(kind string, n int) {
	if n == 0 {
		return
	}
	if s.Kinds == nil {
		s.Kinds = map[string]int{}
	}
	s.Kinds[kind] += n
	s.Count += n
}

// FromEnv reads REDACTION_ENABLED / REDACTION_PII / REDACTION_DISABLE.
func FromEnv() Options {
	o := Options{Enabled: true, Disabled: map[string]bool{}}
	if v := strings.TrimSpace(strings.ToLower(os.Getenv("REDACTION_ENABLED"))); v == "false" || v == "0" || v == "off" {
		o.Enabled = false
	}
	if v := strings.TrimSpace(strings.ToLower(os.Getenv("REDACTION_PII"))); v == "true" || v == "1" || v == "on" {
		o.PII = true
	}
	for _, name := range strings.Split(os.Getenv("REDACTION_DISABLE"), ",") {
		if name = strings.TrimSpace(strings.ToLower(name)); name != "" {
			o.Disabled[name] = true
		}
	}
	return o
}

func (o Options) on(rule string) bool { return o.Enabled && !o.Disabled[rule] }

// --- key-name rule ---------------------------------------------------------

// sensitiveKey matches a credential word as a whole segment of the normalized
// key (db_password, POSTGRES_PASSWORD, clientSecret → client_secret, apiKey →
// api_key); "tokenizer" or "max_tokens" do not match.
var sensitiveKey = regexp.MustCompile(`(^|_)(password|passwd|pwd|secret|token|api_key|access_key|private_key|credentials?|client_secret|dsn|connection_string)(_|$)`)

// notSecretKey: names that contain a credential word but are references or
// settings, not values (secretName, secretKeyRef, token_ttl, password_min_length).
var notSecretKey = regexp.MustCompile(`(name|ref|url|uri|path|file|dir|ttl|length|count|min|max|timeout|mode|type|enabled|id|version|algorithm|alg|header|claim|issuer|audience|scope)s?$`)

var camelBoundary = regexp.MustCompile(`([a-z0-9])([A-Z])`)

// normalizeKey turns camelCase / kebab-case / dotted keys into lower snake_case
// so one rule covers every spelling.
func normalizeKey(key string) string {
	key = camelBoundary.ReplaceAllString(key, "${1}_${2}")
	key = strings.NewReplacer("-", "_", ".", "_").Replace(key)
	return strings.ToLower(key)
}

// keyValueLine: one `key: value` / `key=value` / `export KEY=value` line
// (YAML, env files, describe output). Only spaces/tabs are allowed around the
// separator so a `data:` line never swallows the next line as its value.
// Group 1 = prefix through the separator, 2 = key, 3 = opening quote,
// 4 = value, 5 = closing quote and trailing comma.
var keyValueLine = regexp.MustCompile(`(?m)^([ \t]*-?[ \t]*(?:export[ \t]+)?"?([A-Za-z0-9_.\-]+)"?[ \t]*[:=][ \t]*)("?)([^"\r\n]*?)("?[ \t]*,?)[ \t]*$`)

// jsonPair: `"key": "value"` anywhere in a line, plain or backslash-escaped
// (the escaped form is what a last-applied-configuration annotation holds).
// Group 1 = key quote, 2 = key, 3 = through the opening value quote,
// 4 = value, 5 = closing quote.
var jsonPair = regexp.MustCompile(`(\\?")([A-Za-z0-9_.\-]+)(\\?"[ \t]*:[ \t]*\\?")((?:[^"\\]|\\[^"]|\\\\")*?)(\\?")`)

// envListYAML / envListJSON: a container env entry `- name: X_PASSWORD` +
// `value: ...` (and the JSON form) — the key is "value", so the name decides.
var envListYAML = regexp.MustCompile(`(?m)^([ \t]*-?[ \t]*name:[ \t]*"?([A-Za-z0-9_.\-]+)"?[ \t]*\r?\n[ \t]*value:[ \t]*)("?)([^"\r\n]*?)("?)[ \t]*$`)
var envListJSON = regexp.MustCompile(`("name"[ \t]*:[ \t]*"([A-Za-z0-9_.\-]+)"[ \t]*,[ \t]*"value"[ \t]*:[ \t]*")([^"]*)(")`)

func valueLooksHarmless(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" || v == "null" || v == "~" || v == "[]" || v == "{}" || v == "|" || v == ">" || v == "|-" || v == ">-" {
		return true
	}
	if strings.HasPrefix(v, "<REDACTED") || strings.HasPrefix(v, "<set to the key") || strings.HasPrefix(v, "<EMAIL") {
		return true
	}
	switch strings.ToLower(v) {
	case "true", "false", "yes", "no", "on", "off", "none", "auto", "default":
		return true
	}
	// numbers and short enums (ttl: 60, mode: strict)
	isNumber := true
	for _, r := range v {
		if (r < '0' || r > '9') && r != '.' && r != '-' && r != 'm' && r != 's' && r != 'h' {
			isNumber = false
			break
		}
	}
	return isNumber
}

func keyIsSensitive(key string) bool {
	k := normalizeKey(key)
	return sensitiveKey.MatchString(k) && !notSecretKey.MatchString(k)
}

// --- value-pattern rules ---------------------------------------------------

var (
	privateKeyBlock = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	urlCredentials  = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.\-]*://[^:/\s@"']+:)[^@\s"']+(@)`)
	authorization   = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=\-]{16,})`)
	jwtToken        = regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b`)
	awsAccessKey    = regexp.MustCompile(`\b(AKIA|ASIA)[0-9A-Z]{16}\b`)
	awsSecretValue  = regexp.MustCompile(`(?i)(aws_secret_access_key\s*[:=]\s*"?)([A-Za-z0-9/+=]{40})`)

	emailAddr = regexp.MustCompile(`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`)
	krPhone   = regexp.MustCompile(`\b01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b`)
	krRRN     = regexp.MustCompile(`\b\d{6}[-\s]?[1-4]\d{6}\b`)
	cardNum   = regexp.MustCompile(`\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b`)
)

// Text redacts free text (kubectl output, logs, YAML, JSON). Secret documents
// are stripped even when o.Enabled is false.
func Text(s string, o Options) (string, Stats) {
	var st Stats
	if s == "" {
		return s, st
	}
	if strings.Contains(s, "kind: Secret") || strings.Contains(s, `"kind": "Secret"`) || strings.Contains(s, `"kind":"Secret"`) {
		var n int
		s, n = stripSecretDocuments(s)
		st.add("secret", n)
	}
	if !o.Enabled {
		return s, st
	}
	if o.on("private_key") {
		s = replaceCount(privateKeyBlock, s, func(string) string { return "<REDACTED:private_key>" }, &st, "private_key")
	}
	if o.on("url_credentials") {
		s = replaceCount(urlCredentials, s, func(m string) string {
			sub := urlCredentials.FindStringSubmatch(m)
			return sub[1] + "<REDACTED:password>" + sub[2]
		}, &st, "url_credentials")
	}
	if o.on("authorization") {
		s = replaceCount(authorization, s, func(m string) string {
			sub := authorization.FindStringSubmatch(m)
			return sub[1] + " <REDACTED:token>"
		}, &st, "authorization")
	}
	if o.on("jwt") {
		s = replaceCount(jwtToken, s, func(string) string { return "<REDACTED:jwt>" }, &st, "jwt")
	}
	if o.on("aws_key") {
		s = replaceCount(awsAccessKey, s, func(string) string { return "<REDACTED:aws_access_key>" }, &st, "aws_key")
		s = replaceCount(awsSecretValue, s, func(m string) string {
			sub := awsSecretValue.FindStringSubmatch(m)
			return sub[1] + "<REDACTED:aws_secret_key>"
		}, &st, "aws_key")
	}
	if o.on("key_name") {
		s = replaceCount(jsonPair, s, func(m string) string {
			sub := jsonPair.FindStringSubmatch(m)
			key, value := sub[2], sub[4]
			if !keyIsSensitive(key) || valueLooksHarmless(value) {
				return m
			}
			return sub[1] + key + sub[3] + "<REDACTED:" + key + ">" + sub[5]
		}, &st, "key_name")
		s = replaceCount(envListJSON, s, func(m string) string {
			sub := envListJSON.FindStringSubmatch(m)
			if !keyIsSensitive(sub[2]) || valueLooksHarmless(sub[3]) {
				return m
			}
			return sub[1] + "<REDACTED:" + sub[2] + ">" + sub[4]
		}, &st, "key_name")
		s = replaceCount(keyValueLine, s, func(m string) string {
			sub := keyValueLine.FindStringSubmatch(m)
			key, value := sub[2], sub[4]
			if !keyIsSensitive(key) || valueLooksHarmless(value) {
				return m
			}
			return sub[1] + sub[3] + "<REDACTED:" + key + ">" + sub[5]
		}, &st, "key_name")
		s = replaceCount(envListYAML, s, func(m string) string {
			sub := envListYAML.FindStringSubmatch(m)
			if !keyIsSensitive(sub[2]) || valueLooksHarmless(sub[4]) {
				return m
			}
			return sub[1] + sub[3] + "<REDACTED:" + sub[2] + ">" + sub[5]
		}, &st, "key_name")
	}
	if o.PII {
		if o.on("email") {
			seen := map[string]int{}
			s = replaceCount(emailAddr, s, func(m string) string {
				if _, ok := seen[m]; !ok {
					seen[m] = len(seen) + 1
				}
				return fmt.Sprintf("<EMAIL_%d>", seen[m])
			}, &st, "email")
		}
		if o.on("rrn") {
			s = replaceCount(krRRN, s, func(string) string { return "<REDACTED:rrn>" }, &st, "rrn")
		}
		if o.on("card") {
			s = replaceCount(cardNum, s, func(string) string { return "<REDACTED:card>" }, &st, "card")
		}
		if o.on("phone") {
			s = replaceCount(krPhone, s, func(string) string { return "<REDACTED:phone>" }, &st, "phone")
		}
	}
	return s, st
}

func replaceCount(re *regexp.Regexp, s string, f func(string) string, st *Stats, kind string) string {
	n := 0
	out := re.ReplaceAllStringFunc(s, func(m string) string {
		r := f(m)
		if r != m {
			n++
		}
		return r
	})
	st.add(kind, n)
	return out
}

// --- Secret documents ------------------------------------------------------

// stripSecretDocuments walks YAML text (possibly several `---` documents) and,
// inside every document whose kind is Secret, replaces the values under
// `data:` / `stringData:` and removes the last-applied-configuration
// annotation (it carries a copy of the data). JSON Secret documents are
// handled by the key-value pass with the same placeholder.
func stripSecretDocuments(s string) (string, int) {
	docs := strings.Split(s, "\n---")
	total := 0
	for i, doc := range docs {
		if !strings.Contains(doc, "kind: Secret") && !strings.Contains(doc, `"kind"`) {
			continue
		}
		if strings.Contains(doc, "kind: Secret") {
			out, n := stripSecretYAML(doc)
			docs[i], total = out, total+n
		}
		if strings.Contains(doc, `"kind": "Secret"`) || strings.Contains(doc, `"kind":"Secret"`) {
			out, n := stripSecretJSON(docs[i])
			docs[i], total = out, total+n
		}
	}
	return strings.Join(docs, "\n---"), total
}

const lastAppliedKey = "kubectl.kubernetes.io/last-applied-configuration:"

// stripSecretYAML blanks every value under data:/stringData: and the
// last-applied annotation. Blocks are found by indentation at any depth — a
// Secret may sit inside a List's items: ("- data:" or "  data:") rather than
// at the top level — and end at the first line that is not deeper than the
// key. Lines deeper than a value's key continue that value ("key: |" blocks)
// and are dropped.
func stripSecretYAML(doc string) (string, int) {
	lines := strings.Split(doc, "\n")
	n := 0
	block := -1 // indent of the data:/stringData: key while inside its block
	value := -1 // indent of the block's key lines; deeper lines continue a value
	anno := -1  // indent of the annotations: key while inside it
	last := -1  // indent of the last-applied key while inside its (block) value
	for i, line := range lines {
		trim := strings.TrimSpace(line)
		if trim == "" || strings.HasPrefix(trim, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		key, keyIndent := trim, indent
		if strings.HasPrefix(key, "- ") { // "- data:" — the item's keys sit two columns in
			key, keyIndent = strings.TrimLeft(key[2:], " "), indent+2
		}
		if block >= 0 {
			if indent > block {
				if value < 0 {
					value = indent
				}
				if indent == value && strings.Contains(trim, ":") {
					lines[i] = strings.Repeat(" ", indent) + strings.SplitN(trim, ":", 2)[0] + ": <REDACTED:secret>"
					n++
				} else {
					lines[i] = ""
				}
				continue
			}
			block, value = -1, -1
		}
		if anno >= 0 {
			if indent > anno {
				switch {
				case strings.HasPrefix(trim, lastAppliedKey):
					lines[i] = strings.Repeat(" ", indent) + lastAppliedKey + " <REDACTED:secret>"
					n++
					last = indent
				case last >= 0 && indent > last:
					lines[i] = ""
				default:
					last = -1
				}
				continue
			}
			anno, last = -1, -1
		}
		switch key {
		case "data:", "stringData:":
			block, value = keyIndent, -1
		case "annotations:":
			anno, last = keyIndent, -1
		}
	}
	return strings.Join(lines, "\n"), n
}

var jsonSecretData = regexp.MustCompile(`"(data|stringData)"\s*:\s*\{[^{}]*\}`)
var jsonLastApplied = regexp.MustCompile(`"kubectl\.kubernetes\.io/last-applied-configuration"\s*:\s*"(?:[^"\\]|\\.)*"`)

func stripSecretJSON(doc string) (string, int) {
	n := 0
	doc = jsonSecretData.ReplaceAllStringFunc(doc, func(m string) string {
		n++
		field := "data"
		if strings.HasPrefix(m, `"stringData"`) {
			field = "stringData"
		}
		return `"` + field + `": {"<REDACTED>": "secret"}`
	})
	doc = jsonLastApplied.ReplaceAllStringFunc(doc, func(string) string {
		n++
		return `"kubectl.kubernetes.io/last-applied-configuration": "<REDACTED:secret>"`
	})
	return doc, n
}

// --- structured values -----------------------------------------------------

// Object redacts a decoded JSON/YAML value in place: map keys that look like
// credentials lose their string values, every string goes through Text, and
// a map with kind: Secret loses data/stringData entirely.
func Object(v any, o Options) (any, Stats) {
	var st Stats
	return walk(v, o, &st, false), st
}

func walk(v any, o Options, st *Stats, secret bool) any {
	switch t := v.(type) {
	case map[string]any:
		if kind, _ := t["kind"].(string); kind == "Secret" {
			secret = true
			for _, f := range []string{"data", "stringData"} {
				if inner, ok := t[f].(map[string]any); ok {
					for k := range inner {
						inner[k] = "<REDACTED:secret>"
						st.add("secret", 1)
					}
				}
			}
			if meta, ok := t["metadata"].(map[string]any); ok {
				if anno, ok := meta["annotations"].(map[string]any); ok {
					if _, has := anno["kubectl.kubernetes.io/last-applied-configuration"]; has {
						anno["kubectl.kubernetes.io/last-applied-configuration"] = "<REDACTED:secret>"
						st.add("secret", 1)
					}
				}
			}
		}
		for k, val := range t {
			if secret && (k == "data" || k == "stringData") {
				continue
			}
			if s, ok := val.(string); ok && o.on("key_name") && keyIsSensitive(k) && !valueLooksHarmless(s) {
				t[k] = "<REDACTED:" + k + ">"
				st.add("key_name", 1)
				continue
			}
			t[k] = walk(val, o, st, secret)
		}
		return t
	case []any:
		for i, val := range t {
			t[i] = walk(val, o, st, secret)
		}
		return t
	case string:
		out, s2 := Text(t, o)
		st.Count += s2.Count
		for k, n := range s2.Kinds {
			st.add(k, n)
			st.Count -= n // add() counted again
		}
		return out
	default:
		return v
	}
}
