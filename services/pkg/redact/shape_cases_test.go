package redact

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

const shapeCasesFile = "../../ai-service/tests/fixtures/redact_shape_cases.json"

type shapeCases struct {
	Text []struct {
		Name  string `json:"name"`
		Input string `json:"input"`
		Want  string `json:"want"`
	} `json:"text"`
	Objects []struct {
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
		Want  any             `json:"want"`
	} `json:"objects"`
	KeyNames []struct {
		Key    string `json:"key"`
		Redact bool   `json:"redact"`
	} `json:"key_names"`
	Commands []struct {
		Name  string   `json:"name"`
		Input []string `json:"input"`
		Want  []string `json:"want"`
	} `json:"commands"`
	TextWithPersonalData []struct {
		Name         string `json:"name"`
		Input        string `json:"input"`
		Want         string `json:"want"`
		WantNumbered string `json:"want_numbered"`
	} `json:"text_with_personal_data"`
	NumberedPersonalData []struct {
		Name   string                    `json:"name"`
		Key    string                    `json:"key"`
		After  map[string]int            `json:"after"`
		Seed   map[string]map[string]int `json:"seed"`
		Inputs []string                  `json:"inputs"`
		Want   []string                  `json:"want"`
		Table  map[string]map[string]int `json:"table"`
		Reveal *struct {
			Values map[string]string `json:"values"`
			Held   []string          `json:"held"`
		} `json:"reveal"`
	} `json:"numbered_personal_data"`
	MaskKeys []struct {
		Key   string `json:"key"`
		Kind  string `json:"kind"`
		Value string `json:"value"`
		Want  string `json:"want"`
	} `json:"mask_keys"`
}

// tableOf writes a fixture's table, whose keys are the values, as Numbers keeps it.
func tableOf(key string, byValue map[string]map[string]int) NumberTable {
	out := NumberTable{}
	for kind, values := range byValue {
		if len(values) == 0 {
			continue
		}
		out[kind] = map[string]int{}
		for v, n := range values {
			out[kind][MaskKey(key, kind, v)] = n
		}
	}
	return out
}

// The same cases run in ai-service (test_redact_shapes.py): the two rule lists must give the same answers.
func TestSharedShapeCases(t *testing.T) {
	raw, err := os.ReadFile(shapeCasesFile)
	if err != nil {
		t.Fatal(err)
	}
	var cases shapeCases
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.Text) == 0 || len(cases.Objects) == 0 || len(cases.KeyNames) == 0 || len(cases.Commands) == 0 || len(cases.TextWithPersonalData) == 0 ||
		len(cases.NumberedPersonalData) == 0 || len(cases.MaskKeys) == 0 {
		t.Fatal("no cases read")
	}
	for _, c := range cases.MaskKeys {
		t.Run("mask key/"+c.Kind+"/"+c.Value, func(t *testing.T) {
			if got := MaskKey(c.Key, c.Kind, c.Value); got != c.Want {
				t.Errorf("got %s, want %s", got, c.Want)
			}
		})
	}
	for _, c := range cases.NumberedPersonalData {
		t.Run("numbered/"+c.Name, func(t *testing.T) {
			n := &Numbers{Key: c.Key, Table: tableOf(c.Key, c.Seed), After: c.After, Reveal: c.Reveal != nil}
			for i, in := range c.Inputs {
				if got, _ := TextNumbered(in, Options{Enabled: true, PII: true, Numbered: true, Disabled: map[string]bool{}}, n); got != c.Want[i] {
					t.Errorf("text %d: got  %q\nwant %q", i, got, c.Want[i])
				}
			}
			if got, want := n.Copy(), tableOf(c.Key, c.Table); len(got) != len(want) || (len(want) > 0 && !reflect.DeepEqual(got, want)) {
				t.Errorf("table %v, want %v", got, want)
			}
			if c.Reveal == nil {
				if n.Values() != nil || n.Held() != nil {
					t.Errorf("values %v and held %v without reveal", n.Values(), n.Held())
				}
				return
			}
			if got := n.Values(); len(got) != len(c.Reveal.Values) || (len(got) > 0 && !reflect.DeepEqual(got, c.Reveal.Values)) {
				t.Errorf("values %v, want %v", got, c.Reveal.Values)
			}
			if got := n.Held(); !reflect.DeepEqual(got, c.Reveal.Held) {
				t.Errorf("held %v, want %v", got, c.Reveal.Held)
			}
		})
	}
	for _, c := range cases.TextWithPersonalData {
		t.Run("personal/"+c.Name, func(t *testing.T) {
			if got, _ := Text(c.Input, Options{Enabled: true, PII: true, Disabled: map[string]bool{}}); got != c.Want {
				t.Errorf("got  %q\nwant %q", got, c.Want)
			}
			want := c.WantNumbered
			if want == "" {
				want = c.Want
			}
			if got, _ := Text(c.Input, Options{Enabled: true, PII: true, Numbered: true, Disabled: map[string]bool{}}); got != want {
				t.Errorf("numbered: got  %q\nwant %q", got, want)
			}
		})
	}
	for _, c := range cases.Commands {
		t.Run("command/"+c.Name, func(t *testing.T) {
			if got := Command(c.Input, Options{Enabled: true, Disabled: map[string]bool{}}); !reflect.DeepEqual(got, c.Want) {
				t.Errorf("got  %q\nwant %q", got, c.Want)
			}
		})
	}
	opts := Options{Enabled: true, Disabled: map[string]bool{}}
	for _, c := range cases.Text {
		t.Run("text/"+c.Name, func(t *testing.T) {
			if got, _ := Text(c.Input, opts); got != c.Want {
				t.Errorf("got  %q\nwant %q", got, c.Want)
			}
		})
	}
	for _, c := range cases.Objects {
		t.Run("object/"+c.Name, func(t *testing.T) {
			out, _, ok := JSON(string(c.Input), opts)
			if !ok {
				t.Fatalf("not read as JSON: %s", c.Input)
			}
			var got any
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatalf("%s: %v", out, err)
			}
			if !reflect.DeepEqual(got, c.Want) {
				t.Errorf("got  %s\nwant %v", out, c.Want)
			}
		})
		// Helm values come decoded and go through Object: the same answer as the same value in a JSON answer.
		t.Run("decoded/"+c.Name, func(t *testing.T) {
			var decoded any
			if err := json.Unmarshal(c.Input, &decoded); err != nil {
				t.Fatal(err)
			}
			got, _ := Object(decoded, opts)
			if !reflect.DeepEqual(got, c.Want) {
				t.Errorf("got  %v\nwant %v", got, c.Want)
			}
		})
	}
	for _, c := range cases.KeyNames {
		t.Run("key/"+c.Key, func(t *testing.T) {
			out, _ := Text(c.Key+": fake-value-1\n", opts)
			if masked := !strings.Contains(out, "fake-value-1"); masked != c.Redact {
				t.Errorf("masked = %v, want %v: %q", masked, c.Redact, out)
			}
		})
	}
}

// Helm values go through Object, which has its own check on a value.
func TestObjectKeepsTheWorkingDirectoryAndMasksGluedNames(t *testing.T) {
	in := map[string]any{"PWD": "/app", "OLDPWD": "/root", "DB_PWD": "/fake-pass-1", "PGPASSWORD": "fake-pass-1", "APIKEY": "fake-key-1", "tokenizer": "cl100k"}
	want := map[string]any{"PWD": "/app", "OLDPWD": "/root", "DB_PWD": "<REDACTED:DB_PWD>", "PGPASSWORD": "<REDACTED:PGPASSWORD>", "APIKEY": "<REDACTED:APIKEY>", "tokenizer": "cl100k"}
	got, _ := Object(in, Options{Enabled: true, Disabled: map[string]bool{}})
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %v\nwant %v", got, want)
	}
}

// A number comes out of a decoder under any of these types, so each is read as a number.
func TestObjectMasksAPasswordOfDigitsAndKeepsCounts(t *testing.T) {
	in := map[string]any{
		"password": "1234", "adminPassword": "1234", "db_password": 1234, "pwd": int64(1234), "apiKey": 123456.0, "PGPASSWORD": uint(1234),
		"clientSecret": json.Number("1234"), "DB_PASS": "1234", "PGPASS": 1234,
		"token": "60", "secret": 3, "api_keys": 2, "passwords": 3, "secrets": 7, "tokens": 5, "password_expiry_days": 90, "replicas": 3, "ttl": "30m",
		"password_set": true, "client_secret": false, "api_key": nil, "db_pwd": "",
	}
	want := map[string]any{
		"password": "<REDACTED:password>", "adminPassword": "<REDACTED:adminPassword>", "db_password": "<REDACTED:db_password>", "pwd": "<REDACTED:pwd>",
		"apiKey": "<REDACTED:apiKey>", "PGPASSWORD": "<REDACTED:PGPASSWORD>", "clientSecret": "<REDACTED:clientSecret>", "DB_PASS": "<REDACTED:DB_PASS>", "PGPASS": "<REDACTED:PGPASS>",
		"token": "60", "secret": 3, "api_keys": 2, "passwords": 3, "secrets": 7, "tokens": 5, "password_expiry_days": 90, "replicas": 3, "ttl": "30m",
		"password_set": true, "client_secret": false, "api_key": nil, "db_pwd": "",
	}
	got, st := Object(in, Options{Enabled: true, Disabled: map[string]bool{}})
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %v\nwant %v", got, want)
	}
	if st.Kinds["key_name"] != 9 {
		t.Errorf("counted %+v, want 9 masked by key", st)
	}
	off := map[string]any{"password": "1234", "db_password": 1234, "api_keys": []any{"fake-key-1"}}
	kept, _ := Object(off, Options{Enabled: true, Disabled: map[string]bool{"key_name": true}})
	if !reflect.DeepEqual(kept, map[string]any{"password": "1234", "db_password": 1234, "api_keys": []any{"fake-key-1"}}) {
		t.Errorf("rule off: %v", kept)
	}
}

func TestObjectMasksAContainerEnvEntryByItsName(t *testing.T) {
	in := map[string]any{"extraEnv": []any{
		map[string]any{"name": "DB_PASSWORD", "value": "fake-pass-1"},
		map[string]any{"name": "PGPASSWORD", "value": 1234},
		map[string]any{"name": "API_TOKEN", "value": "fake-token-1"},
		map[string]any{"name": "PWD", "value": "/app"},
		map[string]any{"name": "LOG_LEVEL", "value": "debug"},
		map[string]any{"name": "TOKEN_TTL", "value": "60"},
		map[string]any{"name": "DB_PASSWORD", "valueFrom": map[string]any{"secretKeyRef": map[string]any{"name": "db", "key": "password"}}},
	}}
	want := map[string]any{"extraEnv": []any{
		map[string]any{"name": "DB_PASSWORD", "value": "<REDACTED:DB_PASSWORD>"},
		map[string]any{"name": "PGPASSWORD", "value": "<REDACTED:PGPASSWORD>"},
		map[string]any{"name": "API_TOKEN", "value": "<REDACTED:API_TOKEN>"},
		map[string]any{"name": "PWD", "value": "/app"},
		map[string]any{"name": "LOG_LEVEL", "value": "debug"},
		map[string]any{"name": "TOKEN_TTL", "value": "60"},
		map[string]any{"name": "DB_PASSWORD", "valueFrom": map[string]any{"secretKeyRef": map[string]any{"name": "db", "key": "password"}}},
	}}
	got, st := Object(in, Options{Enabled: true, Disabled: map[string]bool{}})
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %v\nwant %v", got, want)
	}
	if st.Kinds["key_name"] != 3 {
		t.Errorf("counted %+v, want 3 masked by key", st)
	}
	off := map[string]any{"name": "DB_PASSWORD", "value": "fake-pass-1"}
	kept, _ := Object(off, Options{Enabled: true, Disabled: map[string]bool{"key_name": true}})
	if !reflect.DeepEqual(kept, map[string]any{"name": "DB_PASSWORD", "value": "fake-pass-1"}) {
		t.Errorf("rule off: %v", kept)
	}
}

func TestListsInTextCountAsTheKeyRule(t *testing.T) {
	opts := Options{Enabled: true, Disabled: map[string]bool{}}
	for _, in := range []string{`log {"api_keys":["fake-1","fake-2"]} end`, "{\n  \"api_keys\": [\n    \"fake-1\",\n    \"fake-2\"\n  ]\n}\n"} {
		if _, st := Text(in, opts); st.Kinds["key_name"] != 2 {
			t.Errorf("%q: counted %+v, want 2", in, st)
		}
		off := Options{Enabled: true, Disabled: map[string]bool{"key_name": true}}
		if got, _ := Text(in, off); got != in {
			t.Errorf("rule off: %q", got)
		}
	}
}

func TestObjectMasksThePluralNamesAndTheShortPassword(t *testing.T) {
	in := map[string]any{
		"api_keys": "fake-key-1", "passwords": []any{"fake-pass-1", "", true}, "MYSQL_PASS": "fake-pass-2", "PGPASS": "fake-pass-3",
		"first_pass": "done", "bypass": "ingress", "pass": "ok", "secrets": []any{"my-tls"}, "tokens": []any{"120"},
		"credentials": []any{map[string]any{"name": "aws", "token": "fake-token-1"}},
	}
	want := map[string]any{
		"api_keys": "<REDACTED:api_keys>", "passwords": []any{"<REDACTED:passwords>", "", true}, "MYSQL_PASS": "<REDACTED:MYSQL_PASS>", "PGPASS": "<REDACTED:PGPASS>",
		"first_pass": "done", "bypass": "ingress", "pass": "ok", "secrets": []any{"my-tls"}, "tokens": []any{"120"},
		"credentials": []any{map[string]any{"name": "aws", "token": "<REDACTED:token>"}},
	}
	got, _ := Object(in, Options{Enabled: true, Disabled: map[string]bool{}})
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %v\nwant %v", got, want)
	}
}

// A Secret's values go whether the rules are on or not, in every spelling, and each is counted for the audit row.
func TestSecretsInFlowOrEscapedFormAreStrippedWithTheRulesOffAndCounted(t *testing.T) {
	for _, in := range []string{
		"{kind: Secret, data: {note: fake-value-1, other: fake-value-2}}\n",
		`msg="{\"kind\":\"Secret\",\"data\":{\"note\":\"fake-value-1\",\"other\":\"fake-value-2\"}}"`,
	} {
		for _, opts := range []Options{{Enabled: true, Disabled: map[string]bool{}}, {Enabled: false}} {
			got, st := Text(in, opts)
			if strings.Contains(got, "fake-value") {
				t.Errorf("enabled %v: %q", opts.Enabled, got)
			}
			if st.Kinds["secret"] != 2 {
				t.Errorf("enabled %v: counted %+v, want 2", opts.Enabled, st)
			}
		}
	}
}

func TestShapesCountAsTheKeyRule(t *testing.T) {
	opts := Options{Enabled: true, Disabled: map[string]bool{}}
	if _, st := Text("token: |\n  fake-block-value\n", opts); st.Kinds["key_name"] != 1 {
		t.Errorf("block = %+v", st)
	}
	if _, st, _ := JSON(`{"password":1234}`, opts); st.Kinds["key_name"] != 1 {
		t.Errorf("number = %+v", st)
	}
	off := Options{Enabled: true, Disabled: map[string]bool{"key_name": true}}
	if got, _ := Text("token: |\n  fake-block-value\n", off); got != "token: |\n  fake-block-value\n" {
		t.Errorf("rule off: %q", got)
	}
	if got, _, _ := JSON(`{"password":1234}`, off); got != `{"password":1234}` {
		t.Errorf("rule off: %q", got)
	}
	if _, st := Text("login password=fake-pass-1 now", opts); st.Kinds["key_name"] != 1 {
		t.Errorf("among words = %+v", st)
	}
	for _, line := range []string{"login password=fake-pass-1 now", `login password="fake pass 1" now`} {
		if got, _ := Text(line, off); got != line {
			t.Errorf("rule off: %q", got)
		}
	}
}

// What is not masked keeps its spelling: a number that went through a decoder could change.
func TestJSONKeepsOtherNumbersAsTheyCame(t *testing.T) {
	in := `{"replicas":3,"ratio":1.50,"big":12345678901234567890,"password":1234}`
	got, _, ok := JSON(in, Options{Enabled: true, Disabled: map[string]bool{}})
	want := `{"replicas":3,"ratio":1.50,"big":12345678901234567890,"password":"<REDACTED:password>"}`
	if !ok || got != want {
		t.Errorf("got %s", got)
	}
}
