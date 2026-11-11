package k8s

import (
	"context"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

// What kubectl create (v1.36.2, raw/20261111/d1-refs/kubectl-create-cases.txt) refuses before the API server, the
// create from YAML refuses as the caller's input — ErrBadInput, a 400 — in words that name the fault and never the
// value cut at a byte count.
func TestCreateFromYAMLRefusesWhatKubectlRefuses(t *testing.T) {
	cases := []struct {
		name, yaml, want string
	}{
		{"unclosed flow", "hello: [unclosed\n", "document 1 is not YAML: line 1: did not find expected ',' or ']'"},
		{"plain text", "just text\n", "document 1 (line 1) is text, not an object with apiVersion, kind and metadata"},
		{"Korean text", "한국어 글입니다\n", "document 1 (line 1) is text, not an object with apiVersion, kind and metadata"},
		{"a list", "- a\n- b\n", "document 1 (line 1) is a list, not an object with apiVersion, kind and metadata"},
		{"a number", "42\n", "document 1 (line 1) is a single value, not an object with apiVersion, kind and metadata"},
		{"comments only", "# only a comment\n", "no objects passed to create: the YAML holds only comments or empty documents"},
		{"separators only", "---\n---\n", "no objects passed to create: the YAML holds only comments or empty documents"},
		{"empty mapping", "{}\n", "document 1: apiVersion not set, kind not set"},
		{"no kind", "apiVersion: v1\n", "document 1: kind not set"},
		{"kind not text", "apiVersion: v1\nkind: [Pod]\nmetadata: {name: x}\n", "document 1: kind not set"},
		{"bad apiVersion", "apiVersion: nope/v1/x\nkind: Pod\nmetadata: {name: x}\n", "document 1: unexpected GroupVersion string: nope/v1/x"},
		{"unknown kind", "apiVersion: v1\nkind: ForbiddenThing\nmetadata: {name: x}\n",
			`document 1: no matches for kind "ForbiddenThing" in version "v1" on this cluster (ensure CRDs are installed first)`},
		{"second document bad", "apiVersion: v1\nkind: Namespace\nmetadata: {name: made}\n---\njust text\n",
			"document 2 (line 5) is text, not an object with apiVersion, kind and metadata"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newServiceWithFakes(t)
			_, err := s.CreateResourcesFromYAML(context.Background(), tc.yaml, "")
			if !errors.Is(err, ErrBadInput) {
				t.Fatalf("err = %v, want ErrBadInput", err)
			}
			if err.Error() != tc.want {
				t.Errorf("err = %q\nwant  %q", err.Error(), tc.want)
			}
			if !utf8.ValidString(err.Error()) || strings.Contains(err.Error(), "한국") {
				t.Errorf("the words hold the caller's value or a cut letter: %q", err.Error())
			}
		})
	}
}

// The documents before the one that stopped the create are made and answered beside the refusal.
func TestCreateFromYAMLAnswersWhatItMadeBeforeABadDocument(t *testing.T) {
	s := newServiceWithFakes(t)
	made, err := s.CreateResourcesFromYAML(context.Background(), "apiVersion: v1\nkind: Namespace\nmetadata: {name: made}\n---\n{}\n", "")
	if !errors.Is(err, ErrBadInput) || len(made) != 1 || made[0]["name"] != "made" {
		t.Fatalf("made = %v, err = %v; want the Namespace made and ErrBadInput", made, err)
	}
}

// A YAML window's apply refuses an emptied window and a value that is not an object before any request.
func TestEditedObjectRefusesAnEmptyWindowAndAValue(t *testing.T) {
	cases := []struct{ name, yaml, want string }{
		{"empty", "", "the YAML is empty: there is nothing to apply"},
		{"spaces", "   \n\n", "the YAML is empty: there is nothing to apply"},
		{"comment", "# nothing\n", "the YAML is empty: there is nothing to apply"},
		{"empty mapping", "{}", "the YAML is empty: there is nothing to apply"},
		{"text", "a", "the YAML is text, not an object with apiVersion, kind and metadata"},
		{"list", "- a", "the YAML is a list, not an object with apiVersion, kind and metadata"},
		{"broken", "a: [", "the YAML does not read: line 1: did not find expected node content"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := editedObject(tc.yaml)
			if !errors.Is(err, ErrBadInput) || err.Error() != tc.want {
				t.Fatalf("err = %v, want %q as ErrBadInput", err, tc.want)
			}
		})
	}
	if obj, err := editedObject("kind: ConfigMap\nmetadata: {name: x}\n"); err != nil || obj["kind"] != "ConfigMap" {
		t.Fatalf("an object: %v, %v", obj, err)
	}
}
