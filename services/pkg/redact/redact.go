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
	"sort"
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
	// A directory with a space, past its first part: /fake pass cannot be told from a value, /home/me/My Docs can.
	pathWithSpaces = regexp.MustCompile(`^/[A-Za-z0-9._~\-]+(/[A-Za-z0-9._~\- ]*)+$`)
	// Two humps in one part of a path read as encoded text.
	encodedPathPart = regexp.MustCompile(`[a-z0-9][A-Z][^/]*[a-z0-9][A-Z]`)
)

// isWorkingDirectory: in the shell's own capitals the name says where a process runs. In lower case it may as well be a
// password's abbreviation, so a value that reads as encoded text goes.
func isWorkingDirectory(key, value string) bool {
	if !workingDirectoryKey.MatchString(key) {
		return false
	}
	v := strings.TrimSpace(value)
	if key == strings.ToUpper(key) {
		return pathShaped.MatchString(v) || pathWithSpaces.MatchString(v)
	}
	return pathShaped.MatchString(v) && !encodedPathPart.MatchString(v)
}

// namesASecretObject: keys charts use for the name of a Secret that holds the value (existingSecret, tlsSecret).
var namesASecretObject = regexp.MustCompile(`(^|_)(existing|tls|ssl|ca|cert|certificate|pull|image_pull)_?secret$`)

func readsAsAName(v string) bool {
	return nameShaped.MatchString(v) && (strings.ContainsAny(v, "-./") || !strings.ContainsAny(v, "0123456789"))
}

// namesAnObject: the name is what a reader needs and holds nothing. In capitals the key is an environment variable, which
// holds the value itself.
func namesAnObject(key, value string) bool {
	return key != strings.ToUpper(key) && namesASecretObject.MatchString(normalizeKey(key)) && readsAsAName(strings.TrimSpace(value))
}

// countsWhatPassed: a small number under a short name (foo_pass: 3) is a count; no password is that short.
func countsWhatPassed(normalizedKey, value string) bool {
	return len(value) < 4 && len(normalizedKey) > 5 && strings.HasSuffix(normalizedKey, "_pass")
}

// commandAfter: what follows KEY=word reads as more of a command line: another assignment, a path, or a word and its flag.
// Anything else cannot be told from a value with spaces.
var commandAfter = regexp.MustCompile(`^[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*=|[./~][^ \t]*(?:[ \t]|$)|[A-Za-z0-9_.\-]+[ \t]+-{1,2}[A-Za-z])`)

// leftToTheWordRule: KEY=word stays with the rule for a line's words when the command after the word is not the value:
// always under a glued name, as PGPASSWORD=x psql has to, and under a name standing apart when the rest reads as a
// command. Whatever that rule cannot read as one word is masked to the end of the line.
func leftToTheWordRule(key, line string) bool {
	loc := inlinePair.FindStringSubmatchIndex(line)
	if loc == nil || line[loc[4]:loc[5]] != key {
		return false
	}
	separated := separatedKey.MatchString(normalizeKey(key))
	if loc[1] == len(line) || line[loc[1]] == ' ' || line[loc[1]] == '\t' {
		return !separated || commandAfter.MatchString(line[loc[1]:])
	}
	return !separated && line[loc[1]] == '}' && strings.HasPrefix(line[loc[8]:loc[9]], "${")
}

// valueStays says whether a sensitive key's text value is left as it is.
func valueStays(key, value string) bool {
	if isWorkingDirectory(key, value) || namesAnObject(key, value) {
		return true
	}
	if !valueLooksHarmless(value) {
		return false
	}
	v := strings.TrimSpace(value)
	k := normalizeKey(key)
	return v == "" || !onlyNumberCharacters(v) || !credentialLastWord.MatchString(k) || countsWhatPassed(k, v)
}

// holdsCredential says whether a decoded member's value is a credential by its key. true, false and null say nothing. A
// number comes as its digits.
func holdsCredential(key, value string, isString, isNumber bool) bool {
	switch {
	case !keyIsSensitive(key):
		return false
	case isString:
		return !valueStays(key, value)
	case isNumber:
		k := normalizeKey(key)
		return credentialLastWord.MatchString(k) && !countsWhatPassed(k, value)
	}
	return false
}

// decodedCredential is holdsCredential for a value out of a decoder, whose numbers come in several types.
func decodedCredential(key string, v any) bool {
	switch t := v.(type) {
	case string:
		return holdsCredential(key, t, true, false)
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64, json.Number:
		return holdsCredential(key, fmt.Sprint(t), false, true)
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
		if !strings.Contains(line, ":") || !strings.ContainsAny(line, "|>") {
			continue
		}
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

var (
	// jsonListOpens: a key and the bracket of its list, in any quote and any level of escaping, or at the line's start: in a
	// sentence a word before a colon is not one.
	jsonListOpens = regexp.MustCompile(`(?m)["']([A-Za-z0-9_.\-]+)\\*["'][ \t]*:[ \t\r\n]*\[|^[ \t]*(?:-[ \t]+)?([A-Za-z0-9_.\-]+)[ \t]*:[ \t]*\[`)
	// jsonListLineStarts: a line that goes on with a list: a string, a bracket, or one word.
	jsonListLineStarts = regexp.MustCompile(`^[ \t]*(?:\\*["'\[\]{}]|[^ \t\r\n,"'\\\[\]{}:]+[ \t]*(?:[,\]}]|\r?$))`)
)

const jsonListWordEnds = " \t\r\n,\"'\\[]{}"

type jsonListOpening struct {
	start, end int
	key, quote string
}

// jsonListOpenings are the sensitive keys' lists in s, in order. A key at the line's start whose list closes on that line
// is the line rule's.
func jsonListOpenings(s string) []jsonListOpening {
	var out []jsonListOpening
	for _, loc := range jsonListOpens.FindAllStringSubmatchIndex(s, -1) {
		if loc[2] < 0 {
			key := s[loc[4]:loc[5]]
			rest := s[loc[1]:]
			if i := strings.IndexAny(rest, "\r\n"); i >= 0 {
				rest = rest[:i]
			}
			if keyIsSensitive(key) && !strings.Contains(rest, "]") {
				out = append(out, jsonListOpening{loc[0], loc[1], key, `"`})
			}
			continue
		}
		if key := s[loc[2]:loc[3]]; keyIsSensitive(key) {
			start := loc[0]
			for start > 0 && s[start-1] == '\\' {
				start--
			}
			out = append(out, jsonListOpening{start, loc[1], key, s[start : loc[0]+1]})
		}
	}
	return out
}

// quoteAt says where a string opens at s[i]: any backslashes, then a quote.
func quoteAt(s string, i int) (level int, ok bool) {
	j := i
	for j < len(s) && s[j] == '\\' {
		j++
	}
	if j < len(s) && (s[j] == '"' || s[j] == '\'') {
		return j - i, true
	}
	return 0, false
}

// lineStringEnd is the index after the string that opens at s[i] with level backslashes, which ends with its line at the
// latest: a text cut short has no closing quote. closed says whether it had one.
func lineStringEnd(s string, i, level int) (end int, closed bool) {
	open := i + level
	q := s[open]
	step := 2 * (level + 1)
	for j := open + 1; j < len(s); j++ {
		switch s[j] {
		case '\r', '\n':
			return j, false
		case q:
			run := 0
			for k := j - 1; k > open && s[k] == '\\'; k-- {
				run++
			}
			if run%step == level {
				return j + 1, true
			}
		}
	}
	return len(s), false
}

// nextLineGoesOnWithAList: the first line after s[i] with anything on it reads as more of a list.
func nextLineGoesOnWithAList(s string, i int) bool {
	for i < len(s) {
		end := strings.IndexByte(s[i:], '\n')
		if end < 0 {
			end = len(s) - i
		}
		line := s[i : i+end]
		if strings.TrimSpace(line) != "" {
			return jsonListLineStarts.MatchString(line)
		}
		i += end + 1
	}
	return true
}

// maskJSONLists masks each item of a sensitive key's list in text, which a parser cannot read when it is a log line or was
// cut short: at any depth of lists, past mappings, in any quote. A mapping has its own keys, a count or a state stays as it
// does on the key's own line, and the list ends at its bracket or the first line that does not read as one. One pass over
// the text, however lists nest.
func maskJSONLists(s string, st *Stats) string {
	if !strings.Contains(s, "[") {
		return s
	}
	openings := jsonListOpenings(s)
	if len(openings) == 0 {
		return s
	}
	type openList struct {
		key, quote      string
		depth, mappings int
	}
	var out strings.Builder
	at := 0
	mask := func(from, to int, list *openList, quote, value string) {
		if !valueStays(list.key, value) {
			out.WriteString(s[at:from])
			out.WriteString(quote + "<REDACTED:" + list.key + ">" + quote)
			at = to
			st.add("key_name", 1)
		}
	}
	var stack []*openList
	next := 0
	for i := 0; i < len(s); {
		for next < len(openings) && openings[next].start < i {
			next++
		}
		if len(stack) == 0 && next == len(openings) {
			break
		}
		if next < len(openings) && (len(stack) == 0 || stack[len(stack)-1].mappings > 0) && (len(stack) == 0 || openings[next].start == i) {
			stack = append(stack, &openList{key: openings[next].key, quote: openings[next].quote, depth: 1})
			i = openings[next].end
			next++
			continue
		}
		list := stack[len(stack)-1]
		c := s[i]
		if list.mappings > 0 {
			level, opens := quoteAt(s, i)
			switch {
			case opens:
				i, _ = lineStringEnd(s, i, level)
			case c == '{':
				list.mappings++
				i++
			case c == '}':
				list.mappings--
				i++
			default:
				i++
			}
			continue
		}
		level, opens := quoteAt(s, i)
		switch {
		case opens:
			end, closed := lineStringEnd(s, i, level)
			first := i + level + 1
			last := end
			if closed {
				last = end - level - 1
			}
			mask(i, end, list, s[i:first], s[first:last])
			i = end
		case c == '\n':
			if !nextLineGoesOnWithAList(s, i+1) {
				stack = stack[:0]
			}
			i++
		case c == ' ' || c == '\t' || c == '\r' || c == ',' || c == '\\':
			i++
		case c == '[':
			list.depth++
			i++
		case c == ']':
			if list.depth--; list.depth == 0 {
				stack = stack[:len(stack)-1]
			}
			i++
		case c == '{':
			list.mappings = 1
			i++
		case c == '}':
			stack = stack[:len(stack)-1]
			i++
		default:
			end := i
			for end < len(s) && !strings.ContainsRune(jsonListWordEnds, rune(s[end])) {
				end++
			}
			mask(i, end, list, list.quote, s[i:end])
			i = end
		}
	}
	if at == 0 {
		return s
	}
	out.WriteString(s[at:])
	return out.String()
}

// maskListValues replaces each item of a sensitive key's list on the lines below it, which the line rules read as words
// with no key. An item that is a mapping has its own keys, and a count or a state stays as it does on the key's own line.
func maskListValues(s string, st *Stats) string {
	if !strings.Contains(s, "\n") {
		return s
	}
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		if !listKeyMayStartAt(line) {
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
	if nextCredentialWord(key, 0) < 0 {
		return false
	}
	k := normalizeKey(key)
	return (sensitiveKey.MatchString(k) && !notSecretKey.MatchString(k)) || isShortPassword(key)
}

// startsWithFold says whether s at i starts with word, in any case of its ASCII letters.
func startsWithFold(s string, i int, word string) bool {
	if len(s)-i < len(word) {
		return false
	}
	for j := 0; j < len(word); j++ {
		c := s[i+j]
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c != word[j] {
			return false
		}
	}
	return true
}

// foldsToASCII: a case-insensitive rule also reads these two letters as s (U+017F) and k (U+212A).
func foldsToASCII(s string, i int) bool {
	switch s[i] {
	case 0xC5:
		return i+1 < len(s) && s[i+1] == 0xBF
	case 0xE2:
		return i+2 < len(s) && s[i+1] == 0x84 && s[i+2] == 0xAA
	}
	return false
}

// nextCredentialWord is where a word every sensitive key holds starts at or after i, -1 if none. It looks ahead of the
// key-name rules: nearly all text holds none, and it costs a tenth of a percent of what those rules cost.
func nextCredentialWord(s string, i int) int {
	for ; i < len(s); i++ {
		switch s[i] {
		case 'p', 'P':
			if startsWithFold(s, i, "pass") || startsWithFold(s, i, "pwd") {
				return i
			}
		case 's', 'S':
			if startsWithFold(s, i, "secret") {
				return i
			}
		case 't', 'T':
			if startsWithFold(s, i, "token") {
				return i
			}
		case 'k', 'K':
			if startsWithFold(s, i, "key") {
				return i
			}
		case 'c', 'C':
			if startsWithFold(s, i, "credential") || startsWithFold(s, i, "connection") {
				return i
			}
		case 'd', 'D':
			if startsWithFold(s, i, "dsn") {
				return i
			}
		case 0xC5, 0xE2:
			if foldsToASCII(s, i) {
				return i
			}
		}
	}
	return -1
}

// containsFold says whether s may hold word to a case-insensitive rule.
func containsFold(s, word string) bool {
	for i := 0; i < len(s); i++ {
		if s[i]|0x20 == word[0] && startsWithFold(s, i, word) || foldsToASCII(s, i) {
			return true
		}
	}
	return false
}

// replaceOnCredentialLines is replaceCount for a rule that reads one line at a time, on the lines holding a credential word.
func replaceOnCredentialLines(re *regexp.Regexp, s string, f func(string) string, st *Stats, kind string) string {
	var out strings.Builder
	at := 0
	for i := nextCredentialWord(s, 0); i >= 0; i = nextCredentialWord(s, i) {
		start := strings.LastIndexByte(s[:i], '\n') + 1
		end := len(s)
		if nl := strings.IndexByte(s[i:], '\n'); nl >= 0 {
			end = i + nl
		}
		line := s[start:end]
		if replaced := replaceCount(re, line, f, st, kind); replaced != line {
			out.WriteString(s[at:start])
			out.WriteString(replaced)
			at = end
		}
		i = end
	}
	if at == 0 {
		return s
	}
	out.WriteString(s[at:])
	return out.String()
}

// holdsProviderPrefix: what providerKey's alternatives start with.
func holdsProviderPrefix(s string) bool {
	for _, prefix := range []string{"sk-", "AIza", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "xox", "hf_"} {
		if strings.Contains(s, prefix) {
			return true
		}
	}
	return false
}

// listKeyMayStartAt: listKey's first colon has nothing after it but space or a comment, without a regexp for each line.
func listKeyMayStartAt(line string) bool {
	colon := strings.IndexByte(line, ':')
	if colon < 0 {
		return false
	}
	rest := strings.TrimLeft(line[colon+1:], " \t")
	return rest == "" || rest == "\r" || rest[0] == '#'
}

// A credential among the words of a line (a log line, a command, a connection string, a URL's query). Prose reads the
// same way ("invalid password: too short"), so only key=value counts there, or a quoted value after = or :, and only a
// key whose last word is the credential: password_policy=strict and token_count=5 are settings.
const (
	inlineWord   = `(?:passwords?|passwds?|pwds?|secret|token|api[_.\-]?keys?|access[_.\-]?keys?|private[_.\-]?keys?|secret[_.\-]?keys?|credentials?|dsns?|connection[_.\-]?strings?|pgpass|[_.\-]pass)`
	inlineKey    = `([A-Za-z0-9_.\-]*?` + inlineWord + `)`
	inlineBefore = `(--from-file=["']?|^|[^A-Za-z0-9_.\-])`
)

// fileAfterAKey: kubectl's --from-file=[key=]source names a file under the key, whatever the key says.
func fileAfterAKey(before, value string) bool {
	return strings.HasPrefix(strings.ToLower(before), "--from-file=") && strings.ContainsAny(value, "/.")
}

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
	if onlyNumberCharacters(v) && (!credential || countsWhatPassed(k, v)) {
		return true // token=5, secret=3, foo_pass=3: a count or a duration
	}
	// In capitals the key is an environment variable, which holds the value itself.
	if credential || key == strings.ToUpper(key) || !inlineNamesAnObject.MatchString(k) {
		return false
	}
	return readsAsAName(v)
}

func maskInlinePair(m string) string {
	sub := inlinePair.FindStringSubmatch(m)
	if inlineValueStays(sub[2], sub[4]) || fileAfterAKey(sub[1], sub[4]) {
		return m
	}
	return sub[1] + sub[2] + sub[3] + "<REDACTED:" + strings.TrimLeft(sub[2], "-") + ">"
}

func maskInlineQuoted(m string) string {
	sub := inlineQuoted.FindStringSubmatch(m)
	if inlineValueStays(sub[2], sub[4]) || fileAfterAKey(sub[1], sub[4]) {
		return m
	}
	quote := sub[4][:1]
	if quote == `\` {
		quote = `\"`
	}
	return sub[1] + sub[2] + sub[3] + quote + "<REDACTED:" + strings.TrimLeft(sub[2], "-") + ">" + quote
}

// --- value-pattern rules ---------------------------------------------------

// spaceChars are the spaces a rule reads between its parts, past the ASCII ones of \s: text in another script may use its own
// (the full-width space of Korean text). The same list is in redact.py.
const spaceChars = `\s\x0b\x1c-\x1f\x{85}\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}`

var (
	privateKeyBlock = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	urlCredentials  = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.\-]*://[^:/\s@"']+:)[^@\s"']+(@)`)
	authorization   = regexp.MustCompile(`(?i)\b(Bearer|Basic)[` + spaceChars + `]+([A-Za-z0-9._~+/=\-]{16,})`)
	jwtToken        = regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b`)
	awsAccessKey    = regexp.MustCompile(`\b(AKIA|ASIA)[0-9A-Z]{16}\b`)
	awsSecretValue  = regexp.MustCompile(`(?i)(aws_secret_access_key[` + spaceChars + `]*[:=][` + spaceChars + `]*"?)([A-Za-z0-9/+=]{40})`)
	// providerKey: API keys by their published prefixes (the gitleaks rule set), with looser lengths since an
	// error message may cut a key short. A bare sk- run counts only with an upper-case letter and a digit,
	// which a Kubernetes object name (lower case) never has.
	providerKey = regexp.MustCompile(`\b(?:sk-[A-Za-z0-9_\-]{20,}|AIza[A-Za-z0-9_\-]{35}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[abposr]-[A-Za-z0-9\-]{10,}|hf_[A-Za-z0-9]{30,})`)

	emailAddr = regexp.MustCompile(`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`)
	krPhone   = regexp.MustCompile(`\b01[016789][-.` + spaceChars + `]?\d{3,4}[-.` + spaceChars + `]?\d{4}\b`)
	krRRN     = regexp.MustCompile(`\b\d{6}[-` + spaceChars + `]?[1-4]\d{6}\b`)
	cardNum   = regexp.MustCompile(`\b\d{4}[-` + spaceChars + `]?\d{4}[-` + spaceChars + `]?\d{4}[-` + spaceChars + `]?\d{4}\b`)
)

// Text redacts free text (kubectl output, logs, YAML, JSON). Secret documents
// are stripped even when o.Enabled is false.
func Text(s string, o Options) (string, Stats) {
	var st Stats
	if s == "" {
		return s, st
	}
	if namesSecret(s) {
		var n int
		s, n = stripSecretDocuments(s)
		st.add("secret", n)
	}
	if !o.Enabled {
		return s, st
	}
	// Each rule first looks for what it cannot match without: most text goes through none of them.
	if o.on("private_key") && strings.Contains(s, "PRIVATE KEY") {
		s = replaceCount(privateKeyBlock, s, func(string) string { return "<REDACTED:private_key>" }, &st, "private_key")
	}
	if o.on("url_credentials") && strings.Contains(s, "://") && strings.IndexByte(s, '@') >= 0 {
		s = replaceCount(urlCredentials, s, func(m string) string {
			sub := urlCredentials.FindStringSubmatch(m)
			return sub[1] + "<REDACTED:password>" + sub[2]
		}, &st, "url_credentials")
	}
	if o.on("authorization") && (containsFold(s, "bearer") || containsFold(s, "basic")) {
		s = replaceCount(authorization, s, func(m string) string {
			sub := authorization.FindStringSubmatch(m)
			return sub[1] + " <REDACTED:token>"
		}, &st, "authorization")
	}
	if o.on("jwt") && strings.Contains(s, "eyJ") {
		s = replaceCount(jwtToken, s, func(string) string { return "<REDACTED:jwt>" }, &st, "jwt")
	}
	if o.on("aws_key") {
		if strings.Contains(s, "AKIA") || strings.Contains(s, "ASIA") {
			s = replaceCount(awsAccessKey, s, func(string) string { return "<REDACTED:aws_access_key>" }, &st, "aws_key")
		}
		if containsFold(s, "aws_secret_access_key") {
			s = replaceCount(awsSecretValue, s, func(m string) string {
				sub := awsSecretValue.FindStringSubmatch(m)
				return sub[1] + "<REDACTED:aws_secret_key>"
			}, &st, "aws_key")
		}
	}
	if o.on("provider_key") && holdsProviderPrefix(s) {
		s = replaceCount(providerKey, s, func(m string) string {
			if strings.HasPrefix(m, "sk-") && !(strings.ContainsAny(m, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") && strings.ContainsAny(m, "0123456789")) {
				return m
			}
			return "<REDACTED:api_key>"
		}, &st, "provider_key")
	}
	if o.on("key_name") && nextCredentialWord(s, 0) >= 0 {
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
		if strings.Contains(s, `"name"`) {
			s = replaceCount(envListJSON, s, func(m string) string {
				sub := envListJSON.FindStringSubmatch(m)
				if !keyIsSensitive(sub[2]) || valueStays(sub[2], sub[3]) {
					return m
				}
				return sub[1] + "<REDACTED:" + sub[2] + ">" + sub[4]
			}, &st, "key_name")
		}
		s = replaceOnCredentialLines(keyValueLine, s, func(m string) string {
			sub := keyValueLine.FindStringSubmatch(m)
			key, value := sub[2], sub[4]
			if !keyIsSensitive(key) || valueStays(key, value) || leftToTheWordRule(key, m) {
				return m
			}
			return sub[1] + sub[3] + "<REDACTED:" + key + ">" + sub[5]
		}, &st, "key_name")
		if strings.Contains(s, "name:") && strings.Contains(s, "value:") {
			s = replaceCount(envListYAML, s, func(m string) string {
				sub := envListYAML.FindStringSubmatch(m)
				if !keyIsSensitive(sub[2]) || valueStays(sub[2], sub[4]) {
					return m
				}
				return sub[1] + sub[3] + "<REDACTED:" + sub[2] + ">" + sub[5]
			}, &st, "key_name")
		}
		s = replaceOnCredentialLines(inlineQuoted, s, maskInlineQuoted, &st, "key_name")
		s = replaceOnCredentialLines(inlinePair, s, maskInlinePair, &st, "key_name")
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
	secretJSONKind = regexp.MustCompile(`"kind"[` + spaceChars + `]*:[` + spaceChars + `]*"Secret"|\bKind=Secret\b`)
	// A field of a JSON Secret that holds its values, up to where the value starts.
	jsonSecretField = regexp.MustCompile(`"(data|stringData|data_values|kubectl\.kubernetes\.io/last-applied-configuration)"[` + spaceChars + `]*:[` + spaceChars + `]*`)
	// The same two as JSON in a string, its quotes escaped: a log line holding an object.
	escapedSecretKind  = regexp.MustCompile(`"kind(\\+)"[` + spaceChars + `]*:[` + spaceChars + `]*\\+"Secret\\+"`)
	escapedSecretField = regexp.MustCompile(`"(data|stringData|data_values|kubectl\.kubernetes\.io/last-applied-configuration)(\\+)"[` + spaceChars + `]*:[` + spaceChars + `]*`)
	// The same two in YAML's flow style, on one line or several: {kind: Secret, data: {key: value}}.
	secretFlowKind  = regexp.MustCompile(`[{,][ \t\r\n]*["']?kind["']?[ \t]*:[ \t]*["']?Secret["']?[ \t\r\n]*[,}]`)
	flowSecretField = regexp.MustCompile(`[{,][ \t\r\n]*["']?(data|stringData|data_values|kubectl\.kubernetes\.io/last-applied-configuration)["']?[ \t]*:[ \t]*`)
)

// maxEscapeLevel: past this many backslashes a quote is not read as JSON in a string.
const maxEscapeLevel = 15

func namesSecretYAML(s string) bool {
	return strings.Contains(s, "kind: Secret") || secretYAMLKind.MatchString(s)
}

// namesSecret: the word comes first, so text that never says it, most of what goes through here, costs one search.
func namesSecret(s string) bool {
	return strings.Contains(s, "Secret") &&
		(namesSecretYAML(s) || secretJSONKind.MatchString(s) || secretFlowKind.MatchString(s) || strings.Contains(s, `"Secret\`) && escapedSecretKind.MatchString(s))
}

// escapedSecretLevels are the levels of escaping at which s says it is a Secret, lowest first.
func escapedSecretLevels(s string) []int {
	if !strings.Contains(s, `"Secret\`) {
		return nil
	}
	seen := map[int]bool{}
	var levels []int
	for _, loc := range escapedSecretKind.FindAllStringSubmatchIndex(s, -1) {
		if level := loc[3] - loc[2]; level <= maxEscapeLevel && !seen[level] {
			seen[level] = true
			levels = append(levels, level)
		}
	}
	sort.Ints(levels)
	return levels
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
		if !strings.Contains(doc, "Secret") {
			continue
		}
		if namesSecretYAML(doc) {
			out, n := stripSecretYAML(doc)
			docs[i], total = out, total+n
		}
		if secretJSONKind.MatchString(docs[i]) {
			out, n := stripSecretJSON(docs[i])
			docs[i], total = out, total+n
		}
		if secretFlowKind.MatchString(docs[i]) {
			out, n := stripSecretFlow(docs[i])
			docs[i], total = out, total+n
		}
		for _, level := range escapedSecretLevels(docs[i]) {
			out, n := stripEscapedSecretJSON(docs[i], level)
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

// stripEscapedSecretJSON is stripSecretJSON for JSON whose quotes each come after level backslashes.
func stripEscapedSecretJSON(doc string, level int) (string, int) {
	var out strings.Builder
	n := 0
	for {
		loc := escapedSecretField.FindStringSubmatchIndex(doc)
		if loc == nil {
			out.WriteString(doc)
			return out.String(), n
		}
		out.WriteString(doc[:loc[1]])
		before := 0
		for before < loc[0] && doc[loc[0]-before-1] == '\\' {
			before++
		}
		if before != level || loc[5]-loc[4] != level {
			doc = doc[loc[1]:]
			continue
		}
		var end int
		if doc[loc[2]:loc[3]] != lastAppliedName && loc[1] < len(doc) && doc[loc[1]] == '{' {
			end = maskEscapedObject(&out, doc, loc[1], level, &n)
		} else {
			end = maskEscapedValue(&out, doc, loc[1], level, &n)
		}
		if end < 0 {
			return out.String(), n
		}
		doc = doc[end:]
	}
}

// escapedStringEnd is the index after the string that opens at s[i] with level backslashes, -1 if s ends first. A quote
// inside it has more backslashes in front of it than the one that closes it, and the count says which.
func escapedStringEnd(s string, i, level int) int {
	first := i + level + 1
	step := 2 * (level + 1)
	for j := first; j < len(s); j++ {
		if s[j] != '"' {
			continue
		}
		run := 0
		for k := j - 1; k >= first && s[k] == '\\'; k-- {
			run++
		}
		if run%step == level {
			return j + 1
		}
	}
	return -1
}

// escapedValueEnd is jsonValueEnd at a level of escaping.
func escapedValueEnd(s string, i, level int) int {
	if i >= len(s) {
		return -1
	}
	quote := strings.Repeat(`\`, level) + `"`
	if strings.HasPrefix(s[i:], quote) {
		return escapedStringEnd(s, i, level)
	}
	if s[i] == '{' || s[i] == '[' {
		depth := 0
		for j := i; j < len(s); {
			if strings.HasPrefix(s[j:], quote) {
				end := escapedStringEnd(s, j, level)
				if end < 0 {
					return -1
				}
				j = end
				continue
			}
			switch s[j] {
			case '{', '[':
				depth++
			case '}', ']':
				if depth--; depth == 0 {
					return j + 1
				}
			}
			j++
		}
		return -1
	}
	j := i
	for j < len(s) && !strings.ContainsRune(",}]\r\n", rune(s[j])) {
		j++
	}
	return j
}

// maskEscapedObject is maskJSONObject at a level of escaping.
func maskEscapedObject(out *strings.Builder, s string, i, level int, n *int) int {
	quote := strings.Repeat(`\`, level) + `"`
	out.WriteByte('{')
	for j := i + 1; j < len(s); {
		c := s[j]
		switch {
		case c == '}':
			out.WriteByte('}')
			return j + 1
		case strings.HasPrefix(s[j:], quote):
			end := escapedStringEnd(s, j, level)
			if end < 0 {
				out.WriteString(quote + secretPlaceholder + quote)
				*n++
				return -1
			}
			colon := end
			for colon < len(s) && isJSONSpace(s[colon]) {
				colon++
			}
			if colon >= len(s) || s[colon] != ':' { // no key: a value out of place is still a value
				if j = maskEscapedValue(out, s, j, level, n); j < 0 {
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
			if j = maskEscapedValue(out, s, j, level, n); j < 0 {
				return -1
			}
		default:
			if c == ',' || isJSONSpace(c) {
				out.WriteByte(c)
			}
			j++
		}
	}
	return -1
}

// maskEscapedValue is maskJSONValue at a level of escaping.
func maskEscapedValue(out *strings.Builder, s string, i, level int, n *int) int {
	quote := strings.Repeat(`\`, level) + `"`
	end := escapedValueEnd(s, i, level)
	value := s[i:]
	if end >= 0 {
		value = s[i:end]
	}
	switch {
	case end >= 0 && (value == "{}" || value == "null" || value == quote+quote || value == "[]" || strings.HasPrefix(value, quote+"<REDACTED")):
		out.WriteString(value)
	default:
		out.WriteString(quote + secretPlaceholder + quote)
		*n++
	}
	return end
}

// stripSecretFlow masks the values of a Secret written in YAML's flow style. Like stripSecretJSON it scans, since the text
// may be cut or hold other text around the object. Key names stay; a value keeps its quote; what is already a placeholder
// stays too.
func stripSecretFlow(doc string) (string, int) {
	var out strings.Builder
	n := 0
	for {
		loc := flowSecretField.FindStringSubmatchIndex(doc)
		if loc == nil {
			out.WriteString(doc)
			return out.String(), n
		}
		out.WriteString(doc[:loc[1]])
		var end int
		if doc[loc[2]:loc[3]] != lastAppliedName && loc[1] < len(doc) && doc[loc[1]] == '{' {
			end = maskFlowObject(&out, doc, loc[1], &n)
		} else {
			end = maskFlowValue(&out, doc, loc[1], &n)
		}
		if end < 0 {
			return out.String(), n
		}
		doc = doc[end:]
	}
}

// maskFlowObject writes the mapping at s[i] with each value masked and returns the index after it, -1 if s ends first.
func maskFlowObject(out *strings.Builder, s string, i int, n *int) int {
	out.WriteByte('{')
	for j := i + 1; j < len(s); {
		switch c := s[j]; {
		case c == '}':
			out.WriteByte('}')
			return j + 1
		case c == ',' || isJSONSpace(c):
			out.WriteByte(c)
			j++
		default:
			if value, isKey := flowKeyEnd(s, j); isKey {
				out.WriteString(s[j:value])
				j = value
			}
			if j = maskFlowValue(out, s, j, n); j < 0 {
				return -1
			}
		}
	}
	return -1
}

// flowKeyEnd says where the value of the key at s[i] starts, if what is there is a key and not a value out of place.
func flowKeyEnd(s string, i int) (int, bool) {
	j := i
	if s[i] == '"' || s[i] == '\'' {
		if j = flowStringEnd(s, i); j < 0 {
			return 0, false
		}
	} else {
		for j < len(s) && !strings.ContainsRune(",}\r\n", rune(s[j])) {
			if s[j] == ':' && (j+1 == len(s) || strings.ContainsRune(" \t\r\n,}", rune(s[j+1]))) {
				break
			}
			j++
		}
	}
	for j < len(s) && (s[j] == ' ' || s[j] == '\t') {
		j++
	}
	if j >= len(s) || s[j] != ':' {
		return 0, false
	}
	j++
	for j < len(s) && (s[j] == ' ' || s[j] == '\t') {
		j++
	}
	return j, true
}

// flowStringEnd is the index after the quoted string at s[i], -1 if s ends first: a backslash escapes in double quotes, a
// doubled quote in single ones.
func flowStringEnd(s string, i int) int {
	q := s[i]
	for j := i + 1; j < len(s); j++ {
		switch {
		case q == '"' && s[j] == '\\':
			j++
		case s[j] == q && q == '\'' && j+1 < len(s) && s[j+1] == q:
			j++
		case s[j] == q:
			return j + 1
		}
	}
	return -1
}

// flowValueEnd is the index after the value at s[i], -1 if s ends inside quotes or brackets.
func flowValueEnd(s string, i int) int {
	if i >= len(s) {
		return -1
	}
	switch s[i] {
	case '"', '\'':
		return flowStringEnd(s, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(s); {
			switch s[j] {
			case '"', '\'':
				end := flowStringEnd(s, j)
				if end < 0 {
					return -1
				}
				j = end
				continue
			case '{', '[':
				depth++
			case '}', ']':
				if depth--; depth == 0 {
					return j + 1
				}
			}
			j++
		}
		return -1
	}
	j := i
	for j < len(s) && !strings.ContainsRune(",}]\r\n", rune(s[j])) {
		j++
	}
	return j
}

// maskFlowValue writes the placeholder for the value at s[i] and returns the index after it, -1 if s ends first. An empty
// value has nothing to hide and stays.
func maskFlowValue(out *strings.Builder, s string, i int, n *int) int {
	end := flowValueEnd(s, i)
	if i >= len(s) {
		return -1
	}
	value := s[i:]
	if end >= 0 {
		value = s[i:end]
	}
	quote := ""
	if value[0] == '"' || value[0] == '\'' {
		quote = value[:1]
	}
	if bare := strings.TrimSpace(value); end >= 0 && (bare == "" || bare == "{}" || bare == "[]" || bare == "null" || bare == "~" || bare == `""` || bare == "''" ||
		strings.HasPrefix(strings.TrimLeft(bare, `"'`), "<REDACTED")) {
		out.WriteString(value)
		return end
	}
	out.WriteString(quote + secretPlaceholder + quote)
	*n++
	return end
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
// name, every string goes through Text, and a map with kind: Secret (or an
// item without a kind in a SecretList) loses data/stringData wherever they sit
// under it, with the last-applied annotation of any annotations under it.
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

// itemIsSecret: a typed list's item carries no kind of its own, and kubectl reads it as the list's (apimachinery
// decodeToList), so an item without one in a SecretList is a Secret.
func itemIsSecret(list map[string]any, key string, item any) bool {
	kind, _ := list["kind"].(string)
	m, ok := item.(map[string]any)
	if !ok || kind != "SecretList" || key != "items" {
		return false
	}
	itemKind, _ := m["kind"].(string)
	return itemKind == ""
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
			if items, ok := val.([]any); ok && k == "items" {
				for _, item := range items {
					stripSecrets(item, secret || itemIsSecret(t, k, item), st)
				}
				continue
			}
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
			if items, ok := val.([]any); ok && k == "items" {
				for i, item := range items {
					items[i] = walk(item, o, st, secret || itemIsSecret(t, k, item))
				}
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
