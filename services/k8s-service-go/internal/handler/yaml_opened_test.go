package handler

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The screen sends the text an edit began from as what it does not share with the text saved (frontend yamlOpenedOf, which
// runs the same cases). The text comes back whole, or as none when the answer does not fit the text saved.
func TestTheOpenedTextIsPutBackFromWhatTheScreenSends(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "frontend", "src", "components", "resource-detail", "yamlOpened.cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name   string   `json:"name"`
		Opened string   `json:"opened"`
		Edited string   `json:"edited"`
		Head   int      `json:"head"`
		Tail   int      `json:"tail"`
		Lines  []string `json:"lines"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 5 {
		t.Fatalf("%d cases", len(cases))
	}
	for _, c := range cases {
		o := &yamlOpened{Head: c.Head, Tail: c.Tail, Lines: c.Lines}
		if got := o.text(c.Edited); got != c.Opened {
			t.Errorf("%s: %q, want %q", c.Name, got, c.Opened)
		}
	}
}

func TestAnOpenedTextThatDoesNotFitIsNone(t *testing.T) {
	var none *yamlOpened
	if got := none.text("a\nb"); got != "" {
		t.Errorf("no text: %q", got)
	}
	for _, o := range []*yamlOpened{{Head: 3}, {Tail: 3}, {Head: 2, Tail: 1}, {Head: -1}, {Tail: -1}} {
		if got := o.text("a\nb"); got != "" {
			t.Errorf("%+v: %q", o, got)
		}
	}
}
