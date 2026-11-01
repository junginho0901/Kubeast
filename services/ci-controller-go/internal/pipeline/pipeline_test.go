package pipeline

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"go.yaml.in/yaml/v3"

	"github.com/junginho0901/kubeast/services/ci-controller-go/schema"
)

type testCase struct {
	Name     string   `yaml:"name"`
	Pipeline string   `yaml:"pipeline"`
	Error    []string `yaml:"error"`
	Schema   string   `yaml:"schema"`
}

func readCases(t testing.TB) []testCase {
	t.Helper()
	data, err := os.ReadFile("testdata/cases.yaml")
	if err != nil {
		t.Fatal(err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var cases []testCase
	if err := dec.Decode(&cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func TestParseCases(t *testing.T) {
	for _, c := range readCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			p, err := Parse([]byte(c.Pipeline))
			if len(c.Error) == 0 {
				if err != nil {
					t.Fatalf("Parse: %v", err)
				}
				if p.Profile == "" || p.Timeout == "" {
					t.Fatalf("defaults not filled: %+v", p)
				}
				return
			}
			if err == nil {
				t.Fatalf("Parse accepted it, want %q", c.Error)
			}
			for _, want := range c.Error {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q\nwant it to contain %q", err, want)
				}
			}
		})
	}
}

// TestSchemaAgrees holds the public JSON Schema to Parse's answers on every
// case: the same verdict, except the rules the schema says it leaves out.
func TestSchemaAgrees(t *testing.T) {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schema.PipelineV1alpha1))
	if err != nil {
		t.Fatal(err)
	}
	c := jsonschema.NewCompiler()
	if err := c.AddResource("pipeline.json", doc); err != nil {
		t.Fatal(err)
	}
	sch, err := c.Compile("pipeline.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range readCases(t) {
		if tc.Schema == "skip" {
			continue
		}
		t.Run(tc.Name, func(t *testing.T) {
			var v any
			if err := yaml.Unmarshal([]byte(tc.Pipeline), &v); err != nil {
				t.Fatal(err)
			}
			b, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(b))
			if err != nil {
				t.Fatal(err)
			}
			schemaOK := sch.Validate(inst) == nil
			want := len(tc.Error) == 0 || tc.Schema == "accepts"
			if schemaOK != want {
				t.Fatalf("schema valid = %v, want %v (Parse error: %v)", schemaOK, want, tc.Error)
			}
		})
	}
}

func TestDefaultsFilled(t *testing.T) {
	p, err := Parse([]byte(`apiVersion: kubeast.io/pipeline/v1alpha1
steps:
  - {name: image, build: {image: ghcr.io/o/a, context: app}}
  - {name: scan, scan: {}}
  - {name: deploy, deploy: {service: web, env: alpha}}
`))
	if err != nil {
		t.Fatal(err)
	}
	b := p.Steps[0].Build
	if b.Dockerfile != "app/Dockerfile" {
		t.Errorf("dockerfile = %q, want app/Dockerfile (under the context)", b.Dockerfile)
	}
	if s := p.Steps[1].Scan; s.From != "image" || s.Severity != "HIGH" {
		t.Errorf("scan = %+v, want from image, severity HIGH", s)
	}
	if d := p.Steps[2].Deploy; d.From != "image" || d.Mode != ModeManual {
		t.Errorf("deploy = %+v, want from image, mode manual", d)
	}
	if p.Profile != "default" || p.Timeout != "60m" {
		t.Errorf("profile, timeout = %q, %q", p.Profile, p.Timeout)
	}
}

func TestDefaultPipelineBuildsOnly(t *testing.T) {
	p := Default("ghcr.io/example/web", "registry")
	if err := p.Normalize(); err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, s := range p.Steps {
		kinds = append(kinds, s.Kind())
	}
	if got := strings.Join(kinds, ","); got != "build,scan" {
		t.Fatalf("default steps = %s, want build,scan (no deploy)", got)
	}
	if p.Steps[1].Scan.From != "image" || p.Steps[0].Build.Dockerfile != "Dockerfile" {
		t.Fatalf("defaults: %+v %+v", p.Steps[0].Build, p.Steps[1].Scan)
	}
}

func TestFileTooLarge(t *testing.T) {
	data := []byte("apiVersion: kubeast.io/pipeline/v1alpha1\n# " + strings.Repeat("x", MaxFileSize))
	if _, err := Parse(data); err == nil || !strings.Contains(err.Error(), "the limit is 65536") {
		t.Fatalf("err = %v", err)
	}
}

func TestParseTimeout(t *testing.T) {
	for in, want := range map[string]time.Duration{"1m": time.Minute, "90m": 90 * time.Minute, "24h": 24 * time.Hour, "1440m": 24 * time.Hour} {
		if got, err := ParseTimeout(in); err != nil || got != want {
			t.Errorf("ParseTimeout(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, in := range []string{"0m", "1441m", "25h", "1d", "10", "-1m", "01m", "1.5h"} {
		if _, err := ParseTimeout(in); err == nil {
			t.Errorf("ParseTimeout(%q) accepted", in)
		}
	}
}

func TestMatch(t *testing.T) {
	withOn := func(on string) *Pipeline {
		p, err := Parse([]byte("apiVersion: kubeast.io/pipeline/v1alpha1\n" + on + "steps: [{name: a, image: x, commands: [y]}]\n"))
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	type ev struct {
		kind, ref string
		want      bool
	}
	cases := []struct {
		name   string
		p      *Pipeline
		events []ev
	}{
		{"no on: default branch pushes and every pull request", withOn(""), []ev{
			{"push", "refs/heads/main", true}, {"push", "refs/heads/dev", false}, {"push", "refs/tags/v1", false},
			{"pull_request", "refs/heads/dev", true}, {"release", "refs/heads/main", false},
		}},
		{"branch and tag globs", withOn("on: {push: {branches: [main, \"release/*\"], tags: [\"v*\"]}, pull_request: {branches: [main]}}\n"), []ev{
			{"push", "refs/heads/main", true}, {"push", "refs/heads/release/1.2", true}, {"push", "refs/heads/release/1/2", false},
			{"push", "refs/heads/dev", false}, {"push", "refs/tags/v1.0", true}, {"push", "refs/tags/x1", false},
			{"pull_request", "refs/heads/main", true}, {"pull_request", "main", true}, {"pull_request", "refs/heads/dev", false},
		}},
		{"push with no lists: every branch, no tag; no pull_request key: none", withOn("on: {push: {}}\n"), []ev{
			{"push", "refs/heads/anything", true}, {"push", "refs/tags/v1", false}, {"pull_request", "refs/heads/main", false},
		}},
		{"tags only", withOn("on: {push: {tags: [\"v*\"]}}\n"), []ev{
			{"push", "refs/heads/main", false}, {"push", "refs/tags/v2", true},
		}},
	}
	for _, c := range cases {
		for _, e := range c.events {
			if got := c.p.Match(e.kind, e.ref, "main"); got != e.want {
				t.Errorf("%s: Match(%s, %s) = %v, want %v", c.name, e.kind, e.ref, got, e.want)
			}
		}
	}
}
