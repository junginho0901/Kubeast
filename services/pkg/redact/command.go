package redact

import (
	"regexp"
	"strings"
)

// Command lines, for the audit row of a terminal's command. The same rules exist in redact.py (redact_command), for an AI
// exec's row; both run the "commands" of redact_shape_cases.json. The key-name rule reads whole lines, so it misses a
// credential among the words of a command (sh -c "mysql --password=x", env TOKEN=x app).

// argSep joins a command's arguments for the rules below, which read it as a space.
const argSep = "\x1f"

const (
	commandWord       = `("[^"\x1f]*"|'[^'\x1f]*'|[^\s"',;|&)\]\x1f]+)`
	commandCredential = `(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|dsn|connection[_-]?string|pgpass|[_.\-]pass)`
)

var (
	wordAssign = regexp.MustCompile(`(?i)(--from-file=["']?|^|[^\w.\-])(-{0,2}[\w.\-]*` + commandCredential + `[\w.\-]*)([ \t]*[=:][ \t]*)` + commandWord)
	wordFlag   = regexp.MustCompile(`(?i)(^|[^\w.\-])(--?[\w.\-]*` + commandCredential + `[\w.\-]*)([\s\x1f]+)` + commandWord)
	// What holds a credential by its place, not its name: -p is a port or a path outside these programs, and a header's
	// whole value is the credential, a scheme word included.
	placedCredentials = []*regexp.Regexp{
		regexp.MustCompile(`(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^|;&\n]{0,500}?[\s\x1f]-p)` + commandWord),
		regexp.MustCompile(`(\bsshpass\b[^|;&\n]{0,500}?[\s\x1f]-p[\s\x1f]*)` + commandWord),
		regexp.MustCompile(`(\bredis-cli\b[^|;&\n]{0,500}?[\s\x1f]-a[\s\x1f]+)` + commandWord),
		regexp.MustCompile(`([\s\x1f](?:-u|--user)[\s=\x1f]+[^\s:\x1f]+:)` + commandWord),
		regexp.MustCompile(`(?i)(\b(?:proxy-authorization|authorization|set-cookie|cookie)[ \t]*:[ \t]*)([^\x1f\n"']+)`),
	}
	shellReference = regexp.MustCompile(`^["']?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?["']?$`)
)

func wordKeyIsSensitive(key string) bool {
	k := strings.TrimLeft(key, "-")
	if keyIsSensitive(k) {
		return true
	}
	n := normalizeKey(k)
	return strings.HasSuffix(n, "password") || strings.HasSuffix(n, "passwd") || strings.HasSuffix(n, "secret") || strings.HasSuffix(n, "token")
}

func notAValue(value string) bool {
	switch strings.ToLower(value) {
	case "true", "false", "yes", "no", "on", "off", "none", "auto", "default", "null", "~", "[]", "{}", "|", ">", "|-", ">-":
		return true
	}
	return false
}

func commandValueStays(key, value string) bool {
	return !wordKeyIsSensitive(key) || shellReference.MatchString(value) ||
		strings.HasPrefix(value, "<REDACTED") || strings.HasPrefix(value, "-") || notAValue(value) ||
		isWorkingDirectory(key, strings.Trim(value, `"'`))
}

// commandWords masks the credentials among the words of a command line. A value that names a shell variable is not one.
func commandWords(s string) string {
	s = wordAssign.ReplaceAllStringFunc(s, func(m string) string {
		sub := wordAssign.FindStringSubmatch(m)
		if commandValueStays(sub[2], sub[4]) || fileAfterAKey(sub[1], sub[4]) {
			return m
		}
		return sub[1] + sub[2] + sub[3] + "<REDACTED:" + strings.TrimLeft(sub[2], "-") + ">"
	})
	s = wordFlag.ReplaceAllStringFunc(s, func(m string) string {
		sub := wordFlag.FindStringSubmatch(m)
		if commandValueStays(sub[2], sub[4]) {
			return m
		}
		return sub[1] + sub[2] + sub[3] + "<REDACTED:" + strings.TrimLeft(sub[2], "-") + ">"
	})
	for _, rule := range placedCredentials {
		s = rule.ReplaceAllString(s, "${1}<REDACTED:password>")
	}
	return s
}

// Command masks a command's arguments one for one: each through the text rules, then the words of all of them together,
// so a flag's value may be the next argument.
func Command(argv []string, o Options) []string {
	masked := make([]string, len(argv))
	for i, a := range argv {
		text, _ := Text(a, o)
		masked[i] = strings.ReplaceAll(text, argSep, " ")
	}
	return strings.Split(commandWords(strings.Join(masked, argSep)), argSep)
}
