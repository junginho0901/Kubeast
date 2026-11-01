// Package eval grades a dashboard an AI builder wrote for a request: the
// checks it must pass without a store (a valid document, the panels asked
// for, PromQL that reads counters as rates, no cluster matcher of its own,
// the namespace it was asked for), and with a Prometheus to run against, that
// every panel and variable returns data — execution, not likeness.
package eval

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Case is one request of evals/dashboards/<id>/case.json.
type Case struct {
	ID       string            `json:"-"`
	Question string            `json:"question"`
	Cluster  string            `json:"cluster"`
	Vars     map[string]string `json:"vars,omitempty"`
	Panels   struct {
		Min int `json:"min"`
		Max int `json:"max"`
	} `json:"panels"`
	Expect []Expect `json:"expect"`
	Scope  []Scope  `json:"scope,omitempty"`
}

// Expect is a panel the answer must have: of one of kinds (any, if empty),
// querying one of metrics, through one of functions and in one of units when
// those are given.
type Expect struct {
	What      string   `json:"what"`
	Metrics   []string `json:"metrics"`
	Functions []string `json:"functions,omitempty"`
	Kinds     []string `json:"kinds,omitempty"`
	Units     []string `json:"units,omitempty"`
}

// Scope: every selector of a metric starting with one of Prefixes must keep
// to label = value (a matcher on label that takes value and nothing else).
type Scope struct {
	Label    string   `json:"label"`
	Value    string   `json:"value"`
	Prefixes []string `json:"prefixes"`
}

// LoadCases reads every <dir>/<id>/case.json, sorted by id.
func LoadCases(dir string) ([]Case, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*", "case.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	var out []Case
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		var c Case
		dec := json.NewDecoder(strings.NewReader(string(b)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&c); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		c.ID = filepath.Base(filepath.Dir(f))
		if c.Question == "" || len(c.Expect) == 0 {
			return nil, fmt.Errorf("%s: a case needs a question and what to expect", f)
		}
		out = append(out, c)
	}
	return out, nil
}
