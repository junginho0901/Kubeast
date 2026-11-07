package redact

import (
	"encoding/json"
	"os"
	"reflect"
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
	if len(cases.Text) == 0 || len(cases.Objects) == 0 {
		t.Fatal("no cases read")
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
