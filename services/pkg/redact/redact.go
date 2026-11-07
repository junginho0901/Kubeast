// Package redact removes credentials (and optionally personal data) from text
// that is about to leave the cluster for a language model: tool results,
// logs, resource YAML, page snapshots. Values are replaced with a placeholder
// that keeps the key name, so the model still sees the structure ("there is a
// password here") without the value.
//
// Two rule families:
//   - key names: a `key: value` / `key=value` / `"key": "value"` line whose key
//     looks like a credential (password, token, api_key, ...) loses its value,
//     and so does a `key=value` among a line's words;
//   - value patterns: AWS keys, private-key blocks, JWTs, credentials inside
//     URLs, Bearer/Basic authorization values, API keys with a published
//     prefix (OpenAI, Anthropic, Google, GitHub, Slack, Hugging Face).
//
// Secret objects are handled separately and unconditionally: a YAML/JSON
// document with `kind: Secret` loses every value under data/stringData and
// its last-applied-configuration annotation, whether redaction is enabled or
// not. The screen path (UI) is not affected by this package.
//
// Text works on free text, JSON (jsontext.go) on a tool's JSON answer string by
// string, StripSecrets on decoded objects before something computes from them.
//
// The same rules exist in services/ai-service/app/services/redact.py; keep
// the two lists in sync. JSON has no Python twin: ai-service masks decoded
// objects there (redact_object) and tool results arrive already masked.
package redact

import (
	"encoding/json"
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
	// private_key, url_credentials, authorization, jwt, aws_key, provider_key,
	// email, phone, rrn, card.
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

// sensitiveKey matches a credential word at the end of a word of the normalized
// key (db_password, POSTGRES_PASSWORD, clientSecret → client_secret, apiKey →
// api_key, names glued together, PGPASSWORD, APIKEY, and the plural, api_keys);
// "tokenizer" or "max_tokens" do not match. "secrets" and "tokens" stay out: they
// name a kind and what a model used far more often than they hold a value.
var sensitiveKey = regexp.MustCompile(`(^|_)[a-z0-9]*(passwords?|passwds?|pwds?|secret|token|api_?keys?|access_?keys?|private_?keys?|secretkeys?|credentials?|dsns?|connection_?strings?)(_|$)`)

// separatedKey: the same words standing apart. A name that matches only the rule above is glued: see leftToTheWordRule.
var separatedKey = regexp.MustCompile(`(^|_)(passwords?|passwds?|pwds?|secret|token|api_keys?|access_keys?|private_keys?|credentials?|dsns?|connection_strings?)(_|$)|[a-z0-9]_pass$`)

// "pass" as a password's short name: the last word after another one (DB_PASS, mysqlPass), or PGPASS. Alone it is a result
// (pass: true), glued it is another word (bypass, compass), and after these words it is a run or a check that passed,
// unless the name is in capitals: an environment variable holds the value itself (E2E_PASS).
var (
	shortPasswordKey = regexp.MustCompile(`[a-z0-9]_pass$|(^|_)pgpass$`)
	passOfARun       = regexp.MustCompile(`(^|_)(first|second|third|fourth|last|final|next|prev|previous|by|single|multi|test|tests|unit|e2e|lint|check|checks|build|gate|scan|summary|result|results|total|all)_pass$`)
)

func isShortPassword(key string) bool {
	k := normalizeKey(strings.TrimLeft(key, "-"))
	return shortPasswordKey.MatchString(k) && (key == strings.ToUpper(key) || !passOfARun.MatchString(k))
}

// notSecretKey: names that contain a credential word but are references or
// settings, not values (secretName, secretKeyRef, token_ttl, password_min_length).
var notSecretKey = regexp.MustCompile(`(name|ref|url|uri|path|file|dir|ttl|length|count|min|max|timeout|mode|type|enabled|id|version|algorithm|alg|header|claim|issuer|audience|scope|policy)s?$`)

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

// credentialLastWord: the key's last word says the value itself is the credential, so a number there is one. Under
// password_expiry_days, token or secret a number may be a setting or a count, and hiding it would change what the
// reader is told.
var credentialLastWord = regexp.MustCompile(`(^|_)[a-z0-9]*(password|passwd|pwd|api_?key|access_?key|secret_?key|private_?key|client_?secret)$|[a-z0-9]_pass$|(^|_)pgpass$`)

// The shell's own variables, as the shell spells them: PWD=/app says where a process runs. DB_PWD=/x, and an ODBC
// connection string's Pwd=/x, are a password whatever they look like.
var (
	workingDirectoryKey = regexp.MustCompile(`^(PWD|OLDPWD|pwd|oldpwd)$`)
	pathShaped          = regexp.MustCompile(`^(~|\.{1,2})?(/[A-Za-z0-9._~\-]*)*$`)
)

func isWorkingDirectory(key, value string) bool {
	return workingDirectoryKey.MatchString(key) && pathShaped.MatchString(strings.TrimSpace(value))
}

// leftToTheWordRule: KEY=word under a glued name stays with the rule for a line's words, as PGPASSWORD=x psql -h db has
// to: the command after the word is not the value. Whatever that rule cannot read as one word is masked to the end of
// the line.
func leftToTheWordRule(key, line string) bool {
	if separatedKey.MatchString(normalizeKey(key)) {
		return false
	}
	loc := inlinePair.FindStringSubmatchIndex(line)
	if loc == nil || line[loc[4]:loc[5]] != key {
		return false
	}
	if loc[1] == len(line) || line[loc[1]] == ' ' || line[loc[1]] == '\t' {
		return true
	}
	return line[loc[1]] == '}' && strings.HasPrefix(line[loc[8]:loc[9]], "${")
}

// valueStays says whether a sensitive key's text value is left as it is.
func valueStays(key, value string) bool {
	if isWorkingDirectory(key, value) {
		return true
	}
	if !valueLooksHarmless(value) {
		return false
	}
	v := strings.TrimSpace(value)
	return v == "" || !onlyNumberCharacters(v) || !credentialLastWord.MatchString(normalizeKey(key))
}

// holdsCredential says whether a decoded member's value is a credential by its key. true, false and null say nothing.
func holdsCredential(key, value string, isString, isNumber bool) bool {
	switch {
	case !keyIsSensitive(key):
		return false
	case isString:
		return !valueStays(key, value)
	case isNumber:
		return credentialLastWord.MatchString(normalizeKey(key))
	}
	return false
}

// decodedCredential is holdsCredential for a value out of a decoder, whose numbers come in several types.
func decodedCredential(key string, v any) bool {
	switch t := v.(type) {
	case string:
		return holdsCredential(key, t, true, false)
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64, json.Number:
		return holdsCredential(key, "", false, true)
	}
	return false
}

// blockKey: a value given as a YAML block (token: |, password: >-), on the lines below the key, which the line rules do
// not read. Group 1 = what stands before the key, 2 = the key.
var blockKey = regexp.MustCompile(`^([ \t]*(?:-[ \t]+)?)"?([A-Za-z0-9_.\-]+)"?[ \t]*:[ \t]*[|>][0-9+\-]*[ \t]*(?:#.*)?\r?$`)

func indentOf(line string) int { return len(line) - len(strings.TrimLeft(line, " \t")) }

// maskBlockValues replaces a sensitive key's block with one placeholder. The block is what sits deeper than the key, as
// in YAML; the key's next sibling and blank lines after the block stay.
func maskBlockValues(s string, st *Stats) string {
	if !strings.ContainsAny(s, "|>") {
		return s
	}
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	for i := 0; i < len(lines); {
		line := lines[i]
		out = append(out, line)
		i++
		m := blockKey.FindStringSubmatch(line)
		if m == nil || !keyIsSensitive(m[2]) {
			continue
		}
		first, end := "", i
		for j := i; j < len(lines); j++ {
			if strings.TrimSpace(lines[j]) == "" {
				continue
			}
			if indentOf(lines[j]) <= len(m[1]) {
				break
			}
			if first == "" {
				first = lines[j]
			}
			end = j + 1
		}
		if first == "" {
			continue
		}
		cr := ""
		if strings.HasSuffix(first, "\r") {
			cr = "\r"
		}
		out = append(out, first[:indentOf(first)]+"<REDACTED:"+m[2]+">"+cr)
		st.add("key_name", 1)
		i = end
	}
	return strings.Join(out, "\n")
}

// listKey: a key with nothing after it, whose value may be the list on the lines below. listItem: one item of that list.
var (
	listKey  = regexp.MustCompile(`^([ \t]*(?:-[ \t]+)?)"?([A-Za-z0-9_.\-]+)"?[ \t]*:[ \t]*(?:#.*)?\r?$`)
	listItem = regexp.MustCompile(`^([ \t]*-[ \t]+)(.*?)([ \t]*\r?)$`)
)

// A JSON string in text, plain or backslash-escaped as an annotation holds it.
const jsonStringInText = `"(?:[^"\\\r\n]|\\[^\r\n])*"|\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"`

var (
	// jsonListInText: `"key": [...]` in a line, up to its bracket or, in text cut short, the line's end. A list holding a
	// mapping or a list does not match: those have their own keys.
	jsonListInText = regexp.MustCompile(`(?m)(\\?")([A-Za-z0-9_.\-]+)(\\?"[ \t]*:[ \t]*\[)((?:` + jsonStringInText + `|[^\[\]{}"\\\r\n])*(?:"[^"\r\n]*)?)(\]|\r?$)`)
	jsonListItem   = regexp.MustCompile(jsonStringInText + `|"[^"\r\n]*$|[^ \t\r\n,"\\]+`)
	// jsonListOpens: a key whose list goes on below this line, quoted or at the line's start: in a sentence a word before a
	// colon is not one. jsonListLine: one item on a line of its own.
	jsonListOpens = regexp.MustCompile(`(?:^[ \t]*(?:-[ \t]+)?"?|")([A-Za-z0-9_.\-]+)"?[ \t]*:[ \t]*\[[^\]\r\n]*\r?$`)
	jsonListLine  = regexp.MustCompile(`^([ \t]*)(` + jsonStringInText + `|"[^"\r\n]*|[^ \t\r\n,"\\\[\]{}:]+)([ \t,\]}]*\r?)$`)
)

// maskListItem masks one item of a JSON list under a sensitive key, in the quote it came in, or quote if it had none.
func maskListItem(key, item, quote string, st *Stats) string {
	value := item
	switch {
	case strings.HasPrefix(item, `\"`):
		value, quote = strings.TrimSuffix(item[2:], `\"`), `\"`
	case strings.HasPrefix(item, `"`):
		value, quote = strings.TrimSuffix(item[1:], `"`), `"`
	}
	if valueStays(key, value) {
		return item
	}
	st.add("key_name", 1)
	return quote + "<REDACTED:" + key + ">" + quote
}

// maskJSONLists masks a sensitive key's JSON list held in one line of text, which a parser cannot read when the text is a
// log line or was cut short.
func maskJSONLists(s string, st *Stats) string {
	return jsonListInText.ReplaceAllStringFunc(s, func(m string) string {
		sub := jsonListInText.FindStringSubmatch(m)
		if !keyIsSensitive(sub[2]) {
			return m
		}
		items := jsonListItem.ReplaceAllStringFunc(sub[4], func(item string) string { return maskListItem(sub[2], item, sub[1], st) })
		return sub[1] + sub[2] + sub[3] + items + sub[5]
	})
}

// maskListValues replaces each item of a sensitive key's list on the lines below it, which the line rules read as words
// with no key. An item that is a mapping has its own keys, and a count or a state stays as it does on the key's own line.
// A JSON list is read up to its first line that is not one item, so what follows a mapping in the same list stays.
func maskListValues(s string, st *Stats) string {
	if !strings.Contains(s, "\n") {
		return s
	}
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		if open := jsonListOpens.FindStringSubmatch(line); open != nil && keyIsSensitive(open[1]) {
			for j := i + 1; j < len(lines); j++ {
				item := jsonListLine.FindStringSubmatch(lines[j])
				if item == nil {
					break
				}
				lines[j] = item[1] + maskListItem(open[1], item[2], `"`, st) + item[3]
			}
			continue
		}
		m := listKey.FindStringSubmatch(line)
		if m == nil || !keyIsSensitive(m[2]) {
			continue
		}
		for j := i + 1; j < len(lines); j++ {
			item := listItem.FindStringSubmatch(lines[j])
			if item == nil || indentOf(lines[j]) < len(m[1]) {
				break
			}
			value, quote := item[2], ""
			if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
				value, quote = value[1:len(value)-1], value[:1]
			}
			if (quote == "" && (strings.Contains(value, ": ") || strings.HasSuffix(value, ":"))) || valueStays(m[2], value) {
				continue
			}
			lines[j] = item[1] + quote + "<REDACTED:" + m[2] + ">" + quote + item[3]
			st.add("key_name", 1)
		}
	}
	return strings.Join(lines, "\n")
}

func valueLooksHarmless(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" || v == "null" || v == "~" || v == "[]" || v == "{}" || v == "[" || v == "{" || v == "|" || v == ">" || v == "|-" || v == ">-" {
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
	return onlyNumberCharacters(v)
}

func onlyNumberCharacters(v string) bool {
	for _, r := range v {
		if (r < '0' || r > '9') && r != '.' && r != '-' && r != 'm' && r != 's' && r != 'h' {
			return false
		}
	}
	return true
}

func keyIsSensitive(key string) bool {
	k := normalizeKey(key)
	return (sensitiveKey.MatchString(k) && !notSecretKey.MatchString(k)) || isShortPassword(key)
}

// A credential among the words of a line (a log line, a command, a connection string, a URL's query). Prose reads the
// same way ("invalid password: too short"), so only key=value counts there, or a quoted value after = or :, and only a
// key whose last word is the credential: password_policy=strict and token_count=5 are settings.
const (
	inlineWord   = `(?:passwords?|passwds?|pwds?|secret|token|api[_.\-]?keys?|access[_.\-]?keys?|private[_.\-]?keys?|secret[_.\-]?keys?|credentials?|dsns?|connection[_.\-]?strings?|pgpass|[_.\-]pass)`
	inlineKey    = `([A-Za-z0-9_.\-]*?` + inlineWord + `)`
	inlineBefore = `(^|[^A-Za-z0-9_.\-])`
)

var (
	inlinePair   = regexp.MustCompile(`(?i)` + inlineBefore + inlineKey + `(=)([^\s"'\\&;,)\]}|={*%<>\[(][^\s"'\\&;,)\]}|]*)`)
	inlineQuoted = regexp.MustCompile(`(?i)` + inlineBefore + inlineKey + `(["'\\]*[ \t]*[=:][ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|\\"[^"\\\r\n]*\\")`)
	// What says a place for a value, not the value: password=$DB_PASSWORD, password=%s.
	inlineReference = regexp.MustCompile(`^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[a-z#+]{1,2}|\*+)$`)
	// These words also name an object: in a Kubernetes log secret=kube-system/my-tls is a Secret, not its value.
	inlineNamesAnObject = regexp.MustCompile(`(secret|credentials?)$`)
	nameShaped          = regexp.MustCompile(`^[a-z0-9._/\-]+$`)
)

// inlineNotAValue says a state, not a value (token=expired), or is the key every Ollama client sends for none.
var inlineNotAValue = map[string]bool{
	"true": true, "false": true, "yes": true, "no": true, "on": true, "off": true, "none": true, "auto": true, "default": true,
	"null": true, "nil": true, "empty": true, "set": true, "unset": true, "missing": true, "required": true, "invalid": true,
	"expired": true, "redacted": true, "hidden": true, "masked": true, "undefined": true, "unknown": true, "ollama": true,
}

func inlineValueStays(key, value string) bool {
	v := strings.TrimSpace(strings.Trim(value, `\"'`))
	if v == "" || strings.HasPrefix(v, "<REDACTED") || inlineNotAValue[strings.ToLower(v)] || inlineReference.MatchString(v) {
		return true
	}
	if isWorkingDirectory(key, v) {
		return true
	}
	k := normalizeKey(strings.TrimLeft(key, "-"))
	if strings.HasSuffix(k, "pass") && !isShortPassword(key) {
		return true // pass=ok, first_pass=done
	}
	credential := credentialLastWord.MatchString(k)
	if !credential && onlyNumberCharacters(v) {
		return true // token=5, secret=3: a count or a duration
	}
	// In capitals the key is an environment variable, which holds the value itself.
	if credential || key == strings.ToUpper(key) || !inlineNamesAnObject.MatchString(k) || !nameShaped.MatchString(v) {
		return false
	}
	return strings.ContainsAny(v, "-./") || !strings.ContainsAny(v, "0123456789")
}

func maskInlinePair(m string) string {
	sub := inlinePair.FindStringSubmatch(m)
	if inlineValueStays(sub[2], sub[4]) {
		return m
	}
	return sub[1] + sub[2] + sub[3] + "<REDACTED:" + strings.TrimLeft(sub[2], "-") + ">"
}

func maskInlineQuoted(m string) string {
	sub := inlineQuoted.FindStringSubmatch(m)
	if inlineValueStays(sub[2], sub[4]) {
		return m
	}
	quote := sub[4][:1]
	if quote == `\` {
		quote = `\"`
	}
	return sub[1] + sub[2] + sub[3] + quote + "<REDACTED:" + strings.TrimLeft(sub[2], "-") + ">" + quote
}

// --- value-pattern rules ---------------------------------------------------

var (
	privateKeyBlock = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	urlCredentials  = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.\-]*://[^:/\s@"']+:)[^@\s"']+(@)`)
	authorization   = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=\-]{16,})`)
	jwtToken        = regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b`)
	awsAccessKey    = regexp.MustCompile(`\b(AKIA|ASIA)[0-9A-Z]{16}\b`)
	awsSecretValue  = regexp.MustCompile(`(?i)(aws_secret_access_key\s*[:=]\s*"?)([A-Za-z0-9/+=]{40})`)
	// providerKey: API keys by their published prefixes (the gitleaks rule set), with looser lengths since an
	// error message may cut a key short. A bare sk- run counts only with an upper-case letter and a digit,
	// which a Kubernetes object name (lower case) never has.
	providerKey = regexp.MustCompile(`\b(?:sk-[A-Za-z0-9_\-]{20,}|AIza[A-Za-z0-9_\-]{35}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[abposr]-[A-Za-z0-9\-]{10,}|hf_[A-Za-z0-9]{30,})`)

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
	if namesSecretYAML(s) || secretJSONKind.MatchString(s) {
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
	if o.on("provider_key") {
		s = replaceCount(providerKey, s, func(m string) string {
			if strings.HasPrefix(m, "sk-") && !(strings.ContainsAny(m, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") && strings.ContainsAny(m, "0123456789")) {
				return m
			}
			return "<REDACTED:api_key>"
		}, &st, "provider_key")
	}
	if o.on("key_name") {
		s = maskBlockValues(s, &st)
		s = maskListValues(s, &st)
		s = maskJSONLists(s, &st)
		s = replaceCount(jsonPair, s, func(m string) string {
			sub := jsonPair.FindStringSubmatch(m)
			key, value := sub[2], sub[4]
			if !keyIsSensitive(key) || valueStays(key, value) {
				return m
			}
			return sub[1] + key + sub[3] + "<REDACTED:" + key + ">" + sub[5]
		}, &st, "key_name")
		s = replaceCount(envListJSON, s, func(m string) string {
			sub := envListJSON.FindStringSubmatch(m)
			if !keyIsSensitive(sub[2]) || valueStays(sub[2], sub[3]) {
				return m
			}
			return sub[1] + "<REDACTED:" + sub[2] + ">" + sub[4]
		}, &st, "key_name")
		s = replaceCount(keyValueLine, s, func(m string) string {
			sub := keyValueLine.FindStringSubmatch(m)
			key, value := sub[2], sub[4]
			if !keyIsSensitive(key) || valueStays(key, value) || leftToTheWordRule(key, m) {
				return m
			}
			return sub[1] + sub[3] + "<REDACTED:" + key + ">" + sub[5]
		}, &st, "key_name")
		s = replaceCount(envListYAML, s, func(m string) string {
			sub := envListYAML.FindStringSubmatch(m)
			if !keyIsSensitive(sub[2]) || valueStays(sub[2], sub[4]) {
				return m
			}
			return sub[1] + sub[3] + "<REDACTED:" + sub[2] + ">" + sub[5]
		}, &st, "key_name")
		s = replaceCount(inlineQuoted, s, maskInlineQuoted, &st, "key_name")
		s = replaceCount(inlinePair, s, maskInlinePair, &st, "key_name")
	}
	return redactPII(s, o, &st), st
}

// redactPII applies the personal-data rules; one address keeps one placeholder across the text it is given.
func redactPII(s string, o Options, st *Stats) string {
	if !o.PII {
		return s
	}
	if o.on("email") {
		seen := map[string]int{}
		s = replaceCount(emailAddr, s, func(m string) string {
			if _, ok := seen[m]; !ok {
				seen[m] = len(seen) + 1
			}
			return fmt.Sprintf("<EMAIL_%d>", seen[m])
		}, st, "email")
	}
	if o.on("rrn") {
		s = replaceCount(krRRN, s, func(string) string { return "<REDACTED:rrn>" }, st, "rrn")
	}
	if o.on("card") {
		s = replaceCount(cardNum, s, func(string) string { return "<REDACTED:card>" }, st, "card")
	}
	if o.on("phone") {
		s = replaceCount(krPhone, s, func(string) string { return "<REDACTED:phone>" }, st, "phone")
	}
	return s
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

const (
	secretPlaceholder = "<REDACTED:secret>"
	lastAppliedName   = "kubectl.kubernetes.io/last-applied-configuration"
	lastAppliedKey    = lastAppliedName + ":"
)

// secretValueFields hold a Secret's values: its own two and the describe answer's data_values.
var secretValueFields = map[string]bool{"data": true, "stringData": true, "data_values": true}

var (
	// A chart may quote the kind or put spaces after the colon; kubectl prints `kind: Secret`.
	secretYAMLKind = regexp.MustCompile(`(?m)^[ \t]*(?:-[ \t]+)?["']?kind["']?[ \t]*:[ \t]*["']?Secret["']?[ \t]*\r?$`)
	// `"kind": "Secret"`, or kubectl's own words in a refused patch, whose JSON does not say what it patches.
	secretJSONKind = regexp.MustCompile(`"kind"\s*:\s*"Secret"|\bKind=Secret\b`)
	// A field of a JSON Secret that holds its values, up to where the value starts.
	jsonSecretField = regexp.MustCompile(`"(data|stringData|data_values|kubectl\.kubernetes\.io/last-applied-configuration)"\s*:\s*`)
)

func namesSecretYAML(s string) bool {
	return strings.Contains(s, "kind: Secret") || secretYAMLKind.MatchString(s)
}

// StripSecretText strips text known to hold a Secret, also when nothing in it says so: an answer cut off by an output
// cap may end before its kind.
func StripSecretText(s string) (string, int) {
	docs := strings.Split(s, "\n---")
	total := 0
	for i, doc := range docs {
		out, n := stripSecretYAML(doc)
		out, m := stripSecretJSON(out)
		docs[i], total = out, total+n+m
	}
	return strings.Join(docs, "\n---"), total
}

// stripSecretDocuments walks text (possibly several `---` documents) and,
// inside every document whose kind is Secret, replaces the values under
// `data:` / `stringData:` and removes the last-applied-configuration
// annotation (it carries a copy of the data).
func stripSecretDocuments(s string) (string, int) {
	docs := strings.Split(s, "\n---")
	total := 0
	for i, doc := range docs {
		if namesSecretYAML(doc) {
			out, n := stripSecretYAML(doc)
			docs[i], total = out, total+n
		}
		if secretJSONKind.MatchString(docs[i]) {
			out, n := stripSecretJSON(docs[i])
			docs[i], total = out, total+n
		}
	}
	return strings.Join(docs, "\n---"), total
}

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
					lines[i] = strings.Repeat(" ", indent) + strings.SplitN(trim, ":", 2)[0] + ": " + secretPlaceholder
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
				case strings.HasPrefix(strings.TrimLeft(trim, `"'`), lastAppliedName):
					lines[i] = strings.Repeat(" ", indent) + lastAppliedKey + " " + secretPlaceholder
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
		field, rest, isKey := strings.Cut(key, ":")
		if !isKey {
			continue
		}
		rest = strings.TrimSpace(rest)
		name := strings.Trim(field, `"' `)
		onItsOwn := rest == "" || strings.HasPrefix(rest, "#")
		switch {
		case name == "data" || name == "stringData":
			switch {
			case onItsOwn:
				block, value = keyIndent, -1
			case rest == "{}" || rest == "null" || rest == "~":
			case !strings.HasPrefix(field, `"`): // JSON's `"data": {` is stripSecretJSON's
				// a flow mapping or a scalar on the key's line, which may go on below it
				lines[i] = line[:strings.Index(line, key)] + field + ": " + secretPlaceholder
				n++
				block, value = keyIndent, -1
			}
		case name == "annotations" && onItsOwn:
			anno, last = keyIndent, -1
		case name == "annotations" && strings.Contains(rest, lastAppliedName) && !strings.HasPrefix(field, `"`):
			lines[i] = line[:strings.Index(line, key)] + field + ": " + secretPlaceholder
			n++
		}
	}
	return strings.Join(lines, "\n"), n
}

// stripSecretJSON masks a JSON Secret's values where a parser cannot be used: the text may be cut, or hold other text
// around the object. The scan keeps to JSON's strings, so braces and quotes inside a value do not end it, and a value
// that never ends takes the rest of the text with it. Key names stay; what is already a placeholder stays too.
func stripSecretJSON(doc string) (string, int) {
	var out strings.Builder
	n := 0
	for {
		loc := jsonSecretField.FindStringSubmatchIndex(doc)
		if loc == nil {
			out.WriteString(doc)
			return out.String(), n
		}
		out.WriteString(doc[:loc[1]])
		var end int
		if doc[loc[2]:loc[3]] != lastAppliedName && loc[1] < len(doc) && doc[loc[1]] == '{' {
			end = maskJSONObject(&out, doc, loc[1], &n)
		} else {
			end = maskJSONValue(&out, doc, loc[1], &n)
		}
		if end < 0 {
			return out.String(), n
		}
		doc = doc[end:]
	}
}

// maskJSONObject writes the object at s[i] with each value masked and returns the index after it, -1 if s ends first.
// Anything in it but keys, values, punctuation and space (a diff's +/- at a line's start) is left out.
func maskJSONObject(out *strings.Builder, s string, i int, n *int) int {
	out.WriteByte('{')
	for j := i + 1; j < len(s); {
		switch c := s[j]; {
		case c == '}':
			out.WriteByte('}')
			return j + 1
		case c == '"':
			end := jsonValueEnd(s, j)
			if end < 0 {
				return -1
			}
			colon := end
			for colon < len(s) && isJSONSpace(s[colon]) {
				colon++
			}
			if colon >= len(s) || s[colon] != ':' { // no key: a value out of place is still a value
				if j = maskJSONValue(out, s, j, n); j < 0 {
					return -1
				}
				continue
			}
			out.WriteString(s[j : colon+1])
			j = colon + 1
			for j < len(s) && isJSONSpace(s[j]) {
				out.WriteByte(s[j])
				j++
			}
			if j = maskJSONValue(out, s, j, n); j < 0 {
				return -1
			}
		default:
			if c == ',' || c == '+' || c == '-' || isJSONSpace(c) {
				out.WriteByte(c)
			}
			j++
		}
	}
	return -1
}

// maskJSONValue writes the placeholder for the value at s[i] and returns the index after it, -1 if s ends first.
// An empty value has nothing to hide and stays.
func maskJSONValue(out *strings.Builder, s string, i int, n *int) int {
	end := jsonValueEnd(s, i)
	value := s[i:]
	if end >= 0 {
		value = s[i:end]
	}
	switch {
	case end >= 0 && (value == "{}" || value == "null" || value == `""` || value == "[]" || strings.HasPrefix(value, `"<REDACTED`)):
		out.WriteString(value)
	default:
		out.WriteString(`"` + secretPlaceholder + `"`)
		*n++
	}
	return end
}

func isJSONSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

// jsonValueEnd is the index after the JSON value that starts at s[i], or -1 if s ends before the value does.
func jsonValueEnd(s string, i int) int {
	if i >= len(s) {
		return -1
	}
	switch s[i] {
	case '"':
		for j := i + 1; j < len(s); j++ {
			switch s[j] {
			case '\\':
				j++
			case '"':
				return j + 1
			}
		}
		return -1
	case '{', '[':
		depth := 0
		for j := i; j < len(s); j++ {
			switch s[j] {
			case '"':
				end := jsonValueEnd(s, j)
				if end < 0 {
					return -1
				}
				j = end - 1
			case '{', '[':
				depth++
			case '}', ']':
				if depth--; depth == 0 {
					return j + 1
				}
			}
		}
		return -1
	}
	j := i
	for j < len(s) && !strings.ContainsRune(",}]\r\n", rune(s[j])) {
		j++
	}
	return j
}

// --- structured values -----------------------------------------------------

// Object redacts a decoded JSON/YAML value in place: map keys that look like
// credentials lose their values, a container env entry's value follows its
// name, every string goes through Text, and a map with kind: Secret loses
// data/stringData wherever they sit under it, with the last-applied annotation
// of any annotations under it.
func Object(v any, o Options) (any, Stats) {
	var st Stats
	return walk(v, o, &st, false), st
}

// StripSecrets removes the values of every Secret in a decoded object or list, in place, and leaves everything else as
// it is. For a result computed from the objects (a jq program), masking what comes out would be too late. Key names
// stay, so which keys a Secret has can still be asked.
func StripSecrets(v any) int {
	var st Stats
	stripSecrets(v, false, &st)
	return st.Kinds["secret"]
}

func stripSecrets(v any, secret bool, st *Stats) {
	switch t := v.(type) {
	case map[string]any:
		if kind, _ := t["kind"].(string); kind == "Secret" {
			secret = true
		}
		if secret {
			maskSecretFields(t, st)
		}
		for k, val := range t {
			if !secret || !secretValueFields[k] {
				stripSecrets(val, secret, st)
			}
		}
	case []any:
		for _, val := range t {
			stripSecrets(val, secret, st)
		}
	}
}

// maskSecretFields masks what one map under a Secret holds of its values.
func maskSecretFields(t map[string]any, st *Stats) {
	for f := range secretValueFields {
		switch val := t[f].(type) {
		case nil:
		case map[string]any:
			for k := range val {
				val[k] = secretPlaceholder
				st.add("secret", 1)
			}
		default:
			t[f] = secretPlaceholder
			st.add("secret", 1)
		}
	}
	if anno, ok := t["annotations"].(map[string]any); ok {
		if _, has := anno[lastAppliedName]; has {
			anno[lastAppliedName] = secretPlaceholder
			st.add("secret", 1)
		}
	}
}

func walk(v any, o Options, st *Stats, secret bool) any {
	switch t := v.(type) {
	case map[string]any:
		if kind, _ := t["kind"].(string); kind == "Secret" {
			secret = true
		}
		if secret {
			maskSecretFields(t, st)
		}
		envName, _ := t["name"].(string) // the key is "value", so the name decides
		for k, val := range t {
			if secret && secretValueFields[k] {
				continue
			}
			if o.on("key_name") && decodedCredential(k, val) {
				t[k] = "<REDACTED:" + k + ">"
				st.add("key_name", 1)
				continue
			}
			if k == "value" && o.on("key_name") && decodedCredential(envName, val) {
				t[k] = "<REDACTED:" + envName + ">"
				st.add("key_name", 1)
				continue
			}
			if list, ok := val.([]any); ok && o.on("key_name") && keyIsSensitive(k) {
				for i, item := range list {
					if decodedCredential(k, item) {
						list[i] = "<REDACTED:" + k + ">"
						st.add("key_name", 1)
					}
				}
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
