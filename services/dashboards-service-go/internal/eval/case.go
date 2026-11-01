// Package eval grades a dashboard an AI builder wrote for a request, or its
// answer that the data is not there: the checks it must pass without a store
// (a valid document, the panels asked for, PromQL that reads counters as
// rates, LogQL and TraceQL that fit their panels, no cluster matcher of its
// own, the namespace it was asked for, an edit that keeps what it was not
// asked to change), and with the stores to run against, that every panel and
// variable returns data and the numbers asked for match the reference —
// execution, not likeness.
package eval

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Case kinds.
const (
	KindBuild   = "build"   // make a dashboard (the default)
	KindEdit    = "edit"    // change base.json as asked
	KindDecline = "decline" // the data is not there: say so instead of a dashboard
)

// Case is one request of evals/dashboards/<id>/case.json.
type Case struct {
	ID       string            `json:"-"`
	Question string            `json:"question"`
	Cluster  string            `json:"cluster"`
	Kind     string            `json:"kind,omitempty"`
	Vars     map[string]string `json:"vars,omitempty"`
	Panels   struct {
		Min int `json:"min"`
		Max int `json:"max"`
	} `json:"panels"`
	Expect    []Expect   `json:"expect,omitempty"`
	ExpectAny *ExpectAny `json:"expect_any,omitempty"`
	Scope     []Scope    `json:"scope,omitempty"`
	// Variables the answer must define.
	Variables []string `json:"variables,omitempty"`
	// Forbid: metric name prefixes no query may read (data that is not there,
	// or a panel the request asked to remove). A decline case names the data
	// that is missing here, and grading with a Prometheus checks that it is.
	Forbid []string `json:"forbid,omitempty"`
	// MayBeEmpty: metrics with series only while a condition holds (a
	// container waiting): an empty query reading one is not a failure.
	MayBeEmpty []string `json:"may_be_empty,omitempty"`
	// Keep (edit): panels of base.json that must stay as they were.
	Keep []string `json:"keep,omitempty"`
	// Seed: the case reads the evaluation's own traces and logs (Seed*).
	Seed bool `json:"seed,omitempty"`

	Reference []byte `json:"-"` // reference.json
	Base      []byte `json:"-"` // base.json, for an edit
}

// Expect is a panel the answer must have: of one of kinds (any, if empty),
// in one of units, with a query on store (prometheus when empty) that reads
// one of metrics (PromQL), uses one of functions, has every label of labels
// in its stream selector (LogQL), contains a string of each group in
// contains, and refers to the variable uses_var.
type Expect struct {
	What      string     `json:"what"`
	Store     string     `json:"store,omitempty"`
	Metrics   []string   `json:"metrics,omitempty"`
	Functions []string   `json:"functions,omitempty"`
	Kinds     []string   `json:"kinds,omitempty"`
	Units     []string   `json:"units,omitempty"`
	Labels    []string   `json:"labels,omitempty"`
	Contains  [][]string `json:"contains,omitempty"`
	UsesVar   string     `json:"uses_var,omitempty"`
	// SameAs: with a Prometheus, the panel's query sums to what the
	// reference panel's query does, within tolerance (a share of it).
	SameAs *SameAs `json:"same_as,omitempty"`
}

// ExpectAny: at least Need of the panels in Of — a request that can be
// answered more than one way.
type ExpectAny struct {
	Need int      `json:"need"`
	Of   []Expect `json:"of"`
}

type SameAs struct {
	Panel     string  `json:"panel"`
	Ref       string  `json:"ref"`
	Tolerance float64 `json:"tolerance"`
}

// Scope: every selector of a metric starting with one of Prefixes must keep
// to label = value (a matcher on label that takes value and nothing else).
type Scope struct {
	Label    string   `json:"label"`
	Value    string   `json:"value"`
	Prefixes []string `json:"prefixes"`
}

// LoadCases reads every <dir>/<id>/case.json with its reference and base,
// sorted by id.
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
		if c.Kind == "" {
			c.Kind = KindBuild
		}
		if err := c.check(); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		folder := filepath.Dir(f)
		if c.Reference, err = os.ReadFile(filepath.Join(folder, "reference.json")); err != nil {
			return nil, fmt.Errorf("%s: a case needs a reference answer: %w", f, err)
		}
		if c.Kind == KindEdit {
			if c.Base, err = os.ReadFile(filepath.Join(folder, "base.json")); err != nil {
				return nil, fmt.Errorf("%s: an edit needs base.json: %w", f, err)
			}
		}
		out = append(out, c)
	}
	return out, nil
}

func (c Case) check() error {
	switch {
	case c.Question == "":
		return fmt.Errorf("a case needs a question")
	case c.Kind != KindBuild && c.Kind != KindEdit && c.Kind != KindDecline:
		return fmt.Errorf("unknown kind %q", c.Kind)
	case c.Kind == KindDecline && len(c.Forbid) == 0:
		return fmt.Errorf("a decline case names what is not there (forbid)")
	case !metricPrefixes(c.Forbid):
		return fmt.Errorf("forbid takes metric name prefixes: %v", c.Forbid)
	case c.Kind != KindDecline && len(c.Expect) == 0 && c.ExpectAny == nil:
		return fmt.Errorf("a case needs what to expect")
	case c.ExpectAny != nil && (c.ExpectAny.Need < 1 || c.ExpectAny.Need > len(c.ExpectAny.Of)):
		return fmt.Errorf("expect_any needs 1 to %d", len(c.ExpectAny.Of))
	}
	return nil
}

var metricPrefix = regexp.MustCompile(`^[A-Za-z_:][A-Za-z0-9_:]*$`)

func metricPrefixes(ps []string) bool {
	for _, p := range ps {
		if !metricPrefix.MatchString(p) {
			return false
		}
	}
	return true
}
