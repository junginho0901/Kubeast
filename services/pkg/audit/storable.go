package audit

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
)

// indexedMax is the most bytes of text an indexed column takes whatever they are: PostgreSQL's index entry is at most
// 2,704 bytes, 12 of them not the text's.
const indexedMax = 2692

// storable is rec with the text PostgreSQL refuses made one it takes, and nothing else changed: a row is written after
// its action ran, so no text in it may keep it out of the table. ai-service's twin is app/services/audit_text.py; both
// run the cases of audit_text_cases.json.
func storable(rec Record) Record {
	for _, s := range []*string{
		&rec.Service, &rec.Action, &rec.ActorUserID, &rec.ActorEmail, &rec.TargetID, &rec.TargetType, &rec.TargetEmail,
		&rec.Cluster, &rec.Namespace, &rec.Result, &rec.Error, &rec.RequestIP, &rec.UserAgent, &rec.RequestID, &rec.Path,
	} {
		*s = storableText(*s)
	}
	for _, s := range []*string{&rec.Service, &rec.Action, &rec.ActorUserID, &rec.TargetID} {
		*s = cutText(*s, indexedMax)
	}
	rec.Before, rec.After = storableJSON(rec.Before), storableJSON(rec.After)
	return rec
}

// storableText is s as a text column takes it: U+FFFD for each byte that is not UTF-8, 0x00 dropped.
func storableText(s string) string {
	return strings.Map(func(r rune) rune {
		if r == 0 {
			return -1
		}
		return r // a byte that is not UTF-8 comes as U+FFFD
	}, s)
}

// cutText is the characters of s that fit in n bytes.
func cutText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

var replacement = []byte(string(utf8.RuneError)) // U+FFFD

// jsonEscape matches one escape of a JSON text, a pair of surrogates as one.
var jsonEscape = regexp.MustCompile(`\\u[dD][89abAB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\.`)

// storableJSON is raw as a JSONB column takes it: U+FFFD for each byte that is not UTF-8, for \u0000 (dropped, it
// could make two keys one) and for half a pair of surrogates. What is not JSON was never masked, so its length stands for it.
func storableJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	if !utf8.Valid(raw) {
		raw = bytes.ToValidUTF8(raw, replacement)
	}
	if !json.Valid(raw) {
		return json.RawMessage(fmt.Sprintf(`{"not_json_bytes":%d}`, len(raw)))
	}
	return jsonEscape.ReplaceAllFunc(raw, func(esc []byte) []byte {
		if len(esc) == 6 && (string(esc[2:]) == "0000" || isSurrogate(esc[2:])) {
			return replacement
		}
		return esc
	})
}

func isSurrogate(hex []byte) bool {
	return (hex[0] == 'd' || hex[0] == 'D') && strings.IndexByte("89abcdefABCDEF", hex[1]) >= 0
}

// refusedForItsText reports whether PostgreSQL refused a row for what it holds (a data exception, or a value past a
// limit) rather than for the state of the table. 2200H and 22003 are what every row gets once its ids have run out.
func refusedForItsText(err error) bool {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		return false
	}
	switch pg.Code {
	case "2200H", "22003":
		return false
	case "54000", "54001":
		return true
	}
	return strings.HasPrefix(pg.Code, "22")
}
