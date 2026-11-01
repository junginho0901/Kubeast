// Package gate checks rendered objects before they are synced: their shape
// against Kubernetes and custom resource schemas (kubeconform as a library)
// and the platform's rules (OPA Rego, embedded). Strict by default, with the
// knobs an environment turns: a mode per rule, the installer's own rules,
// more schema locations, allowed registries — and a workload's exceptions.
package gate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/open-policy-agent/opa/v1/rego"
	"github.com/yannh/kubeconform/pkg/resource"
	"github.com/yannh/kubeconform/pkg/validator"
)

//go:embed policy.rego
var defaultPolicy string

//go:embed schemas/schemas.tar.gz
var schemaArchive []byte

// Mode says what a finding of a rule does.
type Mode string

const (
	Enforce Mode = "enforce" // the sync stops
	Warn    Mode = "warn"    // the sync goes on; the finding is shown and recorded
	Off     Mode = "off"     // the rule does not run
)

// Rules the gate itself adds next to the policy's.
const (
	RuleSchema        = "schema"         // an object does not match its schema
	RuleSchemaMissing = "schema-missing" // no schema for the kind in any location
)

// DefaultModes are the modes when an environment says nothing. Every rule
// enforces except host-users: user namespaces need Linux 6.3+ and
// containerd 2.0+ on the nodes, so an environment turns it to enforce when
// its nodes have them; and a kind without a schema is shown, not stopped.
var DefaultModes = map[string]Mode{
	"host-users":      Warn,
	RuleSchemaMissing: Warn,
}

// File is an installer's Rego module.
type File struct {
	Name string
	Data []byte
}

// Config sets up a gate.
type Config struct {
	// KubernetesVersion fills {{.NormalizedKubernetesVersion}} in extra
	// schema locations. The embedded schemas are 1.37.2's (schemas/sources.txt).
	KubernetesVersion string
	// SchemaLocations are kubeconform locations (a path or URL template)
	// tried after the embedded schemas, for kinds raw files bring.
	SchemaLocations []string
	// Policies are more Rego modules in package kubeast.deploy; their
	// findings join the default policy's.
	Policies []File
	// AllowedRegistries, when set, are the image prefixes allowed.
	AllowedRegistries []string
	// Modes override DefaultModes per rule.
	Modes map[string]Mode
}

// Gate is safe for concurrent use: the schemas are compiled once and the
// Rego query is prepared once (OPA's prepared queries may be shared).
type Gate struct {
	cfg       Config
	modes     map[string]Mode
	validator validator.Validator
	query     rego.PreparedEvalQuery
	dir       string
}

// New unpacks the embedded schemas into a temporary directory, which Close
// removes, and prepares the policy.
func New(ctx context.Context, cfg Config) (*Gate, error) {
	modes := map[string]Mode{}
	for r, m := range DefaultModes {
		modes[r] = m
	}
	for r, m := range cfg.Modes {
		if m != Enforce && m != Warn && m != Off {
			return nil, fmt.Errorf("rule %s: mode %q is not enforce, warn or off", r, m)
		}
		modes[r] = m
	}
	if cfg.KubernetesVersion == "" {
		cfg.KubernetesVersion = "1.37.2"
	}

	dir, err := unpackSchemas()
	if err != nil {
		return nil, err
	}
	locations := append([]string{filepath.Join(dir, "{{.ResourceKind}}{{.KindSuffix}}.json")}, cfg.SchemaLocations...)
	v, err := validator.New(locations, validator.Opts{
		KubernetesVersion:    cfg.KubernetesVersion,
		Strict:               true,
		IgnoreMissingSchemas: true,
	})
	if err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("schema validator: %w", err)
	}

	opts := []func(*rego.Rego){rego.Query("data.kubeast.deploy.finding"), rego.Module("policy.rego", defaultPolicy)}
	for _, p := range cfg.Policies {
		opts = append(opts, rego.Module(p.Name, string(p.Data)))
	}
	q, err := rego.New(opts...).PrepareForEval(ctx)
	if err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("policy: %w", err)
	}
	g := &Gate{cfg: cfg, modes: modes, validator: v, query: q, dir: dir}
	if err := g.warm(ctx); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	return g, nil
}

// embeddedKinds are the kinds of the embedded schemas (schemas/sources.txt).
var embeddedKinds = [][2]string{
	{"apps/v1", "Deployment"},
	{"v1", "Service"},
	{"v1", "ServiceAccount"},
	{"v1", "ConfigMap"},
	{"autoscaling/v2", "HorizontalPodAutoscaler"},
	{"policy/v1", "PodDisruptionBudget"},
	{"batch/v1", "CronJob"},
	{"gateway.networking.k8s.io/v1", "HTTPRoute"},
	{"external-secrets.io/v1", "ExternalSecret"},
	{"monitoring.coreos.com/v1", "ServiceMonitor"},
}

// warm compiles every embedded schema and runs the policy once, so the first
// real check costs what the others do (measured: first check 52 ms before,
// 1.5 ms after; New takes the 0.1 s once, at start).
func (g *Gate) warm(ctx context.Context) error {
	var objs []map[string]interface{}
	for _, k := range embeddedKinds {
		objs = append(objs, map[string]interface{}{"apiVersion": k[0], "kind": k[1], "metadata": map[string]interface{}{"name": "warm"}})
	}
	_, err := g.Check(ctx, Input{Objects: objs})
	return err
}

// Close removes the unpacked schemas.
func (g *Gate) Close() error {
	return os.RemoveAll(g.dir)
}

func unpackSchemas() (string, error) {
	dir, err := os.MkdirTemp("", "kubeast-deploy-schemas-")
	if err != nil {
		return "", err
	}
	zr, err := gzip.NewReader(bytes.NewReader(schemaArchive))
	if err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	tr := tar.NewReader(zr)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			os.RemoveAll(dir)
			return "", err
		}
		name := path.Base(h.Name)
		if h.Typeflag != tar.TypeReg || name != h.Name || !strings.HasSuffix(name, ".json") {
			continue
		}
		data, err := io.ReadAll(tr)
		if err == nil {
			err = os.WriteFile(filepath.Join(dir, name), data, 0o600)
		}
		if err != nil {
			os.RemoveAll(dir)
			return "", err
		}
	}
	return dir, nil
}

// Input is what one check looks at.
type Input struct {
	// Objects are everything a sync would apply (rendered, patched, raw),
	// and the cluster-scoped raw objects waiting for approval.
	Objects []map[string]interface{}
	// Exceptions are the rules the workload asks to be let off
	// (kubeast.io/policy-exception).
	Exceptions []string
	// Approved are the exceptions a platform admin approved. An exception
	// for an enforced rule counts only once approved.
	Approved map[string]bool
}

// Finding is one rule an object breaks.
type Finding struct {
	Rule    string `json:"rule"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Message string `json:"message"`
	Mode    Mode   `json:"mode"`
	// Excepted: the workload's exception covers it (approved, or the rule
	// only warns).
	Excepted bool `json:"excepted,omitempty"`
	// Waiting: an exception covers it but waits for approval; it still blocks.
	Waiting bool `json:"waiting,omitempty"`
}

// Blocks reports whether this finding stops the sync.
func (f Finding) Blocks() bool {
	return f.Mode == Enforce && !f.Excepted
}

// Report is one check's findings, sorted, and notes such as an exception
// that matched nothing.
type Report struct {
	Findings []Finding `json:"findings"`
	Notes    []string  `json:"notes,omitempty"`
}

// Blocked reports whether any finding stops the sync.
func (r Report) Blocked() bool {
	for _, f := range r.Findings {
		if f.Blocks() {
			return true
		}
	}
	return false
}

func (g *Gate) mode(rule string) Mode {
	if m, ok := g.modes[rule]; ok {
		return m
	}
	return Enforce
}

// Check validates the objects against their schemas and evaluates the
// policy once over all of them.
func (g *Gate) Check(ctx context.Context, in Input) (Report, error) {
	var raw []Finding
	for _, o := range in.Objects {
		kind, _ := o["kind"].(string)
		md, _ := o["metadata"].(map[string]interface{})
		name, _ := md["name"].(string)
		b, err := json.Marshal(o)
		if err != nil {
			return Report{}, fmt.Errorf("%s %s: %w", kind, name, err)
		}
		res := g.validator.ValidateResource(resource.Resource{Path: kind + "/" + name, Bytes: b})
		switch res.Status {
		case validator.Invalid:
			for _, ve := range res.ValidationErrors {
				raw = append(raw, Finding{Rule: RuleSchema, Kind: kind, Name: name, Message: fmt.Sprintf("%s: %s", ve.Path, ve.Msg)})
			}
		case validator.Skipped:
			raw = append(raw, Finding{Rule: RuleSchemaMissing, Kind: kind, Name: name, Message: "no schema for " + kind + " in any schema location"})
		case validator.Error:
			msg := "schema check failed"
			if res.Err != nil {
				msg = res.Err.Error()
			}
			raw = append(raw, Finding{Rule: RuleSchema, Kind: kind, Name: name, Message: msg})
		}
	}

	objs := make([]interface{}, len(in.Objects))
	for i, o := range in.Objects {
		objs[i] = o
	}
	regs := make([]interface{}, len(g.cfg.AllowedRegistries))
	for i, r := range g.cfg.AllowedRegistries {
		regs[i] = r
	}
	rs, err := g.query.Eval(ctx, rego.EvalInput(map[string]interface{}{"objects": objs, "allowed_registries": regs}))
	if err != nil {
		return Report{}, fmt.Errorf("policy: %w", err)
	}
	for _, r := range rs {
		for _, e := range r.Expressions {
			set, _ := e.Value.([]interface{})
			for _, item := range set {
				m, _ := item.(map[string]interface{})
				f := Finding{}
				f.Rule, _ = m["rule"].(string)
				f.Kind, _ = m["kind"].(string)
				f.Name, _ = m["name"].(string)
				f.Message, _ = m["msg"].(string)
				if f.Rule == "" {
					return Report{}, fmt.Errorf("policy: a finding without a rule: %v", item)
				}
				raw = append(raw, f)
			}
		}
	}

	excepted := map[string]bool{}
	for _, e := range in.Exceptions {
		excepted[e] = true
	}
	used := map[string]bool{}
	var report Report
	for _, f := range raw {
		f.Mode = g.mode(f.Rule)
		if f.Mode == Off {
			continue
		}
		if excepted[f.Rule] {
			used[f.Rule] = true
			if f.Mode == Warn || in.Approved[f.Rule] {
				f.Excepted = true
			} else {
				f.Waiting = true
				f.Message += " (an exception is asked for and waits for a platform admin's approval)"
			}
		}
		report.Findings = append(report.Findings, f)
	}
	for _, e := range in.Exceptions {
		if !used[e] {
			report.Notes = append(report.Notes, fmt.Sprintf("exception %q matched no finding", e))
		}
	}
	sort.Slice(report.Findings, func(i, j int) bool {
		a, b := report.Findings[i], report.Findings[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		if a.Rule != b.Rule {
			return a.Rule < b.Rule
		}
		return a.Message < b.Message
	})
	sort.Strings(report.Notes)
	return report, nil
}
