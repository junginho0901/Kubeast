package audit

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"
)

// The cases are shared with ai-service (tests/test_audit_text.py), so the two make the same text of the same row.
type auditTextCases struct {
	Text    []struct{ Name, Hex, Want string }
	Indexed []struct {
		Name, Text   string
		Times, Chars int
	}
	JSON []struct{ Name, Input, Want string }
}

func readAuditTextCases(t *testing.T) auditTextCases {
	t.Helper()
	raw, err := os.ReadFile("../../ai-service/tests/fixtures/audit_text_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases auditTextCases
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.Text) == 0 || len(cases.Indexed) == 0 || len(cases.JSON) == 0 {
		t.Fatal("no cases read")
	}
	return cases
}

func TestSharedAuditTextCases(t *testing.T) {
	cases := readAuditTextCases(t)
	for _, c := range cases.Text {
		t.Run("text/"+c.Name, func(t *testing.T) {
			in, err := hex.DecodeString(c.Hex)
			if err != nil {
				t.Fatal(err)
			}
			if got := storableText(string(in)); got != c.Want {
				t.Errorf("got %q, want %q", got, c.Want)
			}
		})
	}
	for _, c := range cases.Indexed {
		t.Run("indexed/"+c.Name, func(t *testing.T) {
			rec := storable(Record{TargetID: strings.Repeat(c.Text, c.Times)})
			if want := strings.Repeat(c.Text, c.Chars); rec.TargetID != want {
				t.Errorf("%d bytes, want %d", len(rec.TargetID), len(want))
			}
		})
	}
	for _, c := range cases.JSON {
		t.Run("json/"+c.Name, func(t *testing.T) {
			got := storableJSON(json.RawMessage(c.Input))
			if c.Input == c.Want && string(got) != c.Input {
				t.Errorf("changed to %s", got)
			}
			var a, b any
			if err := json.Unmarshal(got, &a); err != nil {
				t.Fatalf("%s: %v", got, err)
			}
			if err := json.Unmarshal([]byte(c.Want), &b); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(a, b) {
				t.Errorf("got %s, want %s", got, c.Want)
			}
			if code := refusalOf("after", got); code != "" {
				t.Errorf("%s is refused with %s", got, code)
			}
		})
	}
}

// randomText is valid text without 0x00: any other character, of any length in bytes.
func randomText(r *rand.Rand, n int) string {
	var out strings.Builder
	for i := r.Intn(n + 1); i > 0; i-- {
		var c rune
		switch r.Intn(5) {
		case 0:
			c = rune(1 + r.Intn(0x1f))
		case 1:
			c = rune(0x80 + r.Intn(0x780))
		case 2:
			c = rune(0x800 + r.Intn(0xf800))
		case 3:
			c = rune(0x10000 + r.Intn(0x100000))
		default:
			c = rune(' ' + r.Intn(0x5f))
		}
		if utf8.ValidRune(c) {
			out.WriteRune(c)
		}
	}
	return out.String()
}

func randomJSONValue(r *rand.Rand, depth int) any {
	kinds := 8
	if depth == 0 {
		kinds = 6
	}
	switch r.Intn(kinds) {
	case 0:
		return nil
	case 1:
		return r.Intn(2) == 0
	case 2:
		return r.Int63() - r.Int63()
	case 3:
		return r.NormFloat64() * 1e30
	case 4, 5:
		return randomText(r, 20)
	case 6:
		list := make([]any, r.Intn(5))
		for i := range list {
			list[i] = randomJSONValue(r, depth-1)
		}
		return list
	default:
		object := map[string]any{}
		for i := r.Intn(5); i > 0; i-- {
			object[randomText(r, 8)] = randomJSONValue(r, depth-1)
		}
		return object
	}
}

// What the table took before, it holds byte for byte now: text with no 0x00 that fits its column, JSON however written.
func TestStorableChangesNothingPostgresTakes(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := 0; i < 20000; i++ {
		var rec Record
		v := reflect.ValueOf(&rec).Elem()
		for f := 0; f < v.NumField(); f++ {
			if v.Field(f).Kind() == reflect.String {
				v.Field(f).SetString(randomText(r, 60))
			}
		}
		for _, payload := range []*json.RawMessage{&rec.Before, &rec.After} {
			raw, err := json.Marshal(randomJSONValue(r, 3))
			if err != nil {
				t.Fatal(err)
			}
			switch r.Intn(4) {
			case 0:
				var indented bytes.Buffer
				if err := json.Indent(&indented, raw, " ", "\t"); err != nil {
					t.Fatal(err)
				}
				raw = indented.Bytes()
			case 1:
				raw = escapeEverything(raw)
			case 2:
				raw = nil
			}
			*payload = raw
		}
		for column, value := range map[string][]byte{"before": rec.Before, "after": rec.After} {
			if code := refusalOf(column, value); len(value) > 0 && code != "" {
				t.Fatalf("the test's own JSON is refused with %s: %s", code, value)
			}
		}
		if got := storable(rec); !reflect.DeepEqual(got, rec) {
			t.Fatalf("changed\n%q\nto\n%q", rec, got)
		}
	}
	long := strings.Repeat("x", indexedMax)
	for _, rec := range []Record{
		{Service: long, Action: long, ActorUserID: long, TargetID: long},
		{UserAgent: strings.Repeat("y", 1<<20), Path: strings.Repeat("z", 1<<20), Error: strings.Repeat("e", 1<<20), Cluster: strings.Repeat("c", 1<<16)},
	} {
		if got := storable(rec); !reflect.DeepEqual(got, rec) {
			t.Errorf("a long value was changed")
		}
	}
}

// escapeEverything writes each letter and character of a JSON text's strings as \uXXXX, a character past U+FFFF as a pair.
func escapeEverything(raw []byte) []byte {
	var out bytes.Buffer
	inString := false
	for i := 0; i < len(raw); {
		c, size := utf8.DecodeRune(raw[i:])
		switch {
		case c == '"':
			inString = !inString
			out.WriteByte('"')
		case inString && c == '\\':
			size = 2
			if raw[i+1] == 'u' {
				size = 6
			}
			out.Write(raw[i : i+size])
		case inString && c > 0xffff:
			c -= 0x10000
			out.WriteString(hexEscape(0xd800+c>>10) + hexEscape(0xdc00+c&0x3ff))
		case inString && (c >= 'a' || c >= 0x80):
			out.WriteString(hexEscape(c))
		default:
			out.Write(raw[i : i+size])
		}
		i += size
	}
	return out.Bytes()
}

func hexEscape(c rune) string {
	const digits = "0123456789abcdef"
	return string([]byte{'\\', 'u', digits[c>>12&15], digits[c>>8&15], digits[c>>4&15], digits[c&15]})
}

// Whatever bytes a row holds, the table takes the row.
func TestStorableMakesAnyTextOnePostgresTakes(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	pieces := []string{"\x00", "\xff", "\xed\xa0\x80", `\`, "a", "파", "{", "}", `"`, ":", ",", "[", "]", "1"}
	pieces = append(pieces, strings.Split(`\u0000 \ud800 \uDFFF \ud83d\ude00 \\ \" \n "a" "a": {} []`, " ")...)
	for i := 0; i < 50000; i++ {
		var b strings.Builder
		for n := r.Intn(12); n > 0; n-- {
			b.WriteString(pieces[r.Intn(len(pieces))])
		}
		text, inString := b.String(), `{"a":"`+b.String()+`"}`
		rec := storable(Record{Service: text, Action: text, ActorUserID: text, ActorEmail: text, TargetID: text, TargetType: text, TargetEmail: text,
			Cluster: text, Namespace: text, Result: text, Error: text, RequestIP: text, UserAgent: text, RequestID: text, Path: text,
			Before: json.RawMessage(text), After: json.RawMessage(inString)})
		for column, value := range map[string][]byte{"target_id": []byte(rec.TargetID), "before": jsonOrEmpty(rec.Before), "after": jsonOrEmpty(rec.After)} {
			if code := refusalOf(column, value); code != "" {
				t.Fatalf("%s of %q is refused with %s: %q", column, text, code, value)
			}
		}
	}
}

// A field added to Record takes its place in storable.
func TestStorableReachesEveryFieldOfARecord(t *testing.T) {
	var rec Record
	v := reflect.ValueOf(&rec).Elem()
	for f := 0; f < v.NumField(); f++ {
		switch v.Field(f).Interface().(type) {
		case string:
			v.Field(f).SetString("a\xff\x00b")
		case json.RawMessage:
			v.Field(f).Set(reflect.ValueOf(json.RawMessage("{\"a\":\"\xff\"}")))
		default:
			t.Fatalf("%s is neither text nor JSON", v.Type().Field(f).Name)
		}
	}
	v = reflect.ValueOf(storable(rec))
	for f := 0; f < v.NumField(); f++ {
		want := "a" + string(replacement) + "b"
		if raw, ok := v.Field(f).Interface().(json.RawMessage); ok {
			if string(raw) != `{"a":"`+string(replacement)+`"}` {
				t.Errorf("%s = %q", v.Type().Field(f).Name, raw)
			}
		} else if got := v.Field(f).String(); got != want {
			t.Errorf("%s = %q, want %q", v.Type().Field(f).Name, got, want)
		}
	}
}

// Every text column an index holds is cut: the indexes are read from the migrations.
func TestStorableCutsEveryIndexedColumn(t *testing.T) {
	files, err := filepath.Glob("../dbmigrate/migrations/*.sql")
	if err != nil || len(files) == 0 {
		t.Fatal("no migrations", err)
	}
	index := regexp.MustCompile(`(?is)CREATE\s+(?:UNIQUE\s+)?INDEX[^;]*?\sON\s+auth_audit_logs\s*\(([^;]*?)\)`)
	indexed := map[string]bool{}
	for _, file := range files {
		sql, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range index.FindAllStringSubmatch(string(sql), -1) {
			for _, column := range strings.Split(m[1], ",") {
				indexed[strings.Fields(column)[0]] = true
			}
		}
	}
	for _, notText := range []string{"created_at", "chain_seq", "id"} {
		delete(indexed, notText)
	}
	long := strings.Repeat("x", 3*indexedMax)
	rec := storable(Record{Service: long, Action: long, ActorUserID: long, ActorEmail: long, TargetID: long, TargetType: long, TargetEmail: long,
		Cluster: long, Namespace: long, Result: long, Error: long, RequestIP: long, UserAgent: long, RequestID: long, Path: long})
	byColumn := map[string]string{"service": rec.Service, "action": rec.Action, "actor_user_id": rec.ActorUserID, "actor_email": rec.ActorEmail,
		"target_id": rec.TargetID, "target_type": rec.TargetType, "target_email": rec.TargetEmail, "cluster": rec.Cluster, "namespace": rec.Namespace,
		"result": rec.Result, "error": rec.Error, "request_ip": rec.RequestIP, "user_agent": rec.UserAgent, "request_id": rec.RequestID, "path": rec.Path}
	var cut []string
	for column, value := range byColumn {
		if len(value) < len(long) {
			cut = append(cut, column)
		}
	}
	var want []string
	for column := range indexed {
		want = append(want, column)
	}
	sort.Strings(cut)
	sort.Strings(want)
	if !reflect.DeepEqual(cut, want) || len(want) == 0 {
		t.Errorf("cut %v, the migrations index %v", cut, want)
	}
}
