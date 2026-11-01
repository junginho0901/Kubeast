// Package pipeline reads an app repository's .kubeast/pipeline.yaml: the
// steps a build runs in order (Woodpecker's model — serial steps, the first
// failure stops the build — kept small). A repository without the file gets
// Default: build and push the image, then scan it. Deploying is never
// implied: a pipeline deploys only through a `deploy` step it writes.
package pipeline

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// APIVersion is the only version this package reads.
const APIVersion = "kubeast.io/pipeline/v1alpha1"

// Limits on a pipeline file. They keep one file from costing the controller
// more than a small, fixed amount, and are the same in the public schema.
const (
	MaxFileSize    = 64 << 10
	MaxSteps       = 20
	MaxStepName    = 40
	MaxCommands    = 50
	MaxCommandLen  = 4096
	MaxEnv         = 50
	MaxEnvValueLen = 4096
	MaxSecrets     = 10
	MaxSecretName  = 40
	MaxBuildArgs   = 50
	MaxPatterns    = 20
	MaxPatternLen  = 255
	MaxImageLen    = 255
	MaxTimeout     = 24 * time.Hour
)

// Pipeline is one .kubeast/pipeline.yaml.
type Pipeline struct {
	APIVersion string `yaml:"apiVersion" json:"apiVersion"`
	// On says which events start a build. Nil: pushes to the default branch
	// and every pull request.
	On *Triggers `yaml:"on,omitempty" json:"on,omitempty"`
	// Profile is the runner profile the build pod uses. Empty: "default".
	Profile string `yaml:"profile,omitempty" json:"profile,omitempty"`
	// Timeout bounds the whole build, as "<n>m" or "<n>h". Empty: 60m.
	Timeout string `yaml:"timeout,omitempty" json:"timeout,omitempty"`
	// Env is given to every commands step; a step's own env wins.
	Env   map[string]string `yaml:"env,omitempty" json:"env,omitempty"`
	Steps []Step            `yaml:"steps" json:"steps"`
}

// Triggers are the events a pipeline answers. Patterns are path.Match globs.
type Triggers struct {
	Push        *PushTrigger        `yaml:"push,omitempty" json:"push,omitempty"`
	PullRequest *PullRequestTrigger `yaml:"pull_request,omitempty" json:"pull_request,omitempty"`
}

// PushTrigger matches pushed branches and tags. Both empty: every branch.
type PushTrigger struct {
	Branches []string `yaml:"branches,omitempty" json:"branches,omitempty"`
	Tags     []string `yaml:"tags,omitempty" json:"tags,omitempty"`
}

// PullRequestTrigger matches a pull request's target branch. Empty: every
// target branch.
type PullRequestTrigger struct {
	Branches []string `yaml:"branches,omitempty" json:"branches,omitempty"`
}

// Step is one step. Exactly one of Commands, Build, Scan and Deploy is set.
type Step struct {
	Name string `yaml:"name" json:"name"`
	// Image, Commands, Env and Secrets belong to a commands step.
	Image    string            `yaml:"image,omitempty" json:"image,omitempty"`
	Commands []string          `yaml:"commands,omitempty" json:"commands,omitempty"`
	Env      map[string]string `yaml:"env,omitempty" json:"env,omitempty"`
	// Secrets are the build secrets mounted into this step only, as files
	// under /run/secrets/<name>.
	Secrets []string `yaml:"secrets,omitempty" json:"secrets,omitempty"`
	Build   *Build   `yaml:"build,omitempty" json:"build,omitempty"`
	Scan    *Scan    `yaml:"scan,omitempty" json:"scan,omitempty"`
	Deploy  *Deploy  `yaml:"deploy,omitempty" json:"deploy,omitempty"`
}

// Kind names the kind of step.
func (s Step) Kind() string {
	switch {
	case s.Build != nil:
		return "build"
	case s.Scan != nil:
		return "scan"
	case s.Deploy != nil:
		return "deploy"
	default:
		return "commands"
	}
}

// Build builds an image with BuildKit and pushes it tagged with the commit.
type Build struct {
	// Image is the repository to push to, without a tag or digest; the tag
	// is the commit SHA.
	Image string `yaml:"image" json:"image"`
	// Context is the build context, relative to the repository root.
	// Empty: ".".
	Context string `yaml:"context,omitempty" json:"context,omitempty"`
	// Dockerfile is relative to the repository root, not to the context.
	// Empty: "<context>/Dockerfile".
	Dockerfile string            `yaml:"dockerfile,omitempty" json:"dockerfile,omitempty"`
	Target     string            `yaml:"target,omitempty" json:"target,omitempty"`
	Args       map[string]string `yaml:"args,omitempty" json:"args,omitempty"`
	// RegistrySecret is the build secret holding the registry's Docker
	// config; the scan and deploy steps of this image use it too.
	RegistrySecret string `yaml:"registrySecret,omitempty" json:"registrySecret,omitempty"`
}

// Scan scans an image this pipeline built and fails at Severity or above.
type Scan struct {
	// From is the build step whose image is scanned. Empty: the only build
	// step before this one.
	From string `yaml:"from,omitempty" json:"from,omitempty"`
	// Severity is LOW, MEDIUM, HIGH or CRITICAL. Empty: HIGH.
	Severity string `yaml:"severity,omitempty" json:"severity,omitempty"`
}

// Deploy hands an image this pipeline built to the deploy module, after
// every other step passed. Without a deploy step a pipeline only builds.
type Deploy struct {
	From    string `yaml:"from,omitempty" json:"from,omitempty"`
	Service string `yaml:"service" json:"service"`
	Env     string `yaml:"env" json:"env"`
	// Mode is auto (applied at once) or manual (waits for a person). Empty:
	// manual. An environment set to manual promotion makes auto wait too.
	Mode string `yaml:"mode,omitempty" json:"mode,omitempty"`
}

// Deploy modes.
const (
	ModeAuto   = "auto"
	ModeManual = "manual"
)

// Severities, lowest first.
var Severities = []string{"LOW", "MEDIUM", "HIGH", "CRITICAL"}

// ReservedSteps are the names of the containers Kubeast adds to every build.
var ReservedSteps = []string{"checkout", "report"}

// Default is the pipeline of a repository without .kubeast/pipeline.yaml:
// build and push image from the repository root's Dockerfile, then scan it.
// It does not deploy.
func Default(image, registrySecret string) *Pipeline {
	return &Pipeline{
		APIVersion: APIVersion,
		Steps: []Step{
			{Name: "image", Build: &Build{Image: image, RegistrySecret: registrySecret}},
			{Name: "scan", Scan: &Scan{}},
		},
	}
}

// Parse reads and checks a pipeline file. Unknown keys are refused, every
// problem found is returned together, and the defaults are filled in.
func Parse(data []byte) (*Pipeline, error) {
	if len(data) > MaxFileSize {
		return nil, fmt.Errorf("pipeline file: %d bytes, the limit is %d", len(data), MaxFileSize)
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var p Pipeline
	if err := dec.Decode(&p); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, errors.New("pipeline file: empty")
		}
		return nil, fmt.Errorf("pipeline file: %w", err)
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("pipeline file: more than one YAML document")
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	p.fillDefaults()
	return &p, nil
}

// Validate checks the pipeline as written and returns every problem, sorted.
func (p *Pipeline) Validate() error {
	var v problems
	if p.APIVersion != APIVersion {
		v.add("apiVersion", "must be %s, not %q", APIVersion, p.APIVersion)
	}
	if p.On != nil {
		if p.On.Push != nil {
			v.patterns("on.push.branches", p.On.Push.Branches)
			v.patterns("on.push.tags", p.On.Push.Tags)
		}
		if p.On.PullRequest != nil {
			v.patterns("on.pull_request.branches", p.On.PullRequest.Branches)
		}
	}
	if p.Profile != "" && !dnsLabel(p.Profile, 63) {
		v.add("profile", "%q is not a DNS label", p.Profile)
	}
	if p.Timeout != "" {
		if _, err := ParseTimeout(p.Timeout); err != nil {
			v.add("timeout", "%v", err)
		}
	}
	v.env("env", p.Env)

	switch {
	case len(p.Steps) == 0:
		v.add("steps", "at least one step is needed")
	case len(p.Steps) > MaxSteps:
		v.add("steps", "%d steps, at most %d", len(p.Steps), MaxSteps)
	}
	seen := map[string]bool{}
	builds := map[string]int{} // build step name -> index
	deployTargets := map[string]bool{}
	executable := 0
	lastExecutable := -1
	for i, s := range p.Steps {
		at := fmt.Sprintf("steps[%d]", i)
		if s.Name != "" {
			at = fmt.Sprintf("steps[%d] %s", i, s.Name)
		}
		switch {
		case s.Name == "":
			v.add(at, "name is required")
		case !dnsLabel(s.Name, MaxStepName):
			v.add(at, "name must be a DNS label of at most %d characters", MaxStepName)
		case contains(ReservedSteps, s.Name):
			v.add(at, "name %q is kept for the step Kubeast adds", s.Name)
		case seen[s.Name]:
			v.add(at, "name is used by an earlier step")
		}
		seen[s.Name] = true

		kinds := 0
		for _, set := range []bool{len(s.Commands) > 0 || s.Image != "", s.Build != nil, s.Scan != nil, s.Deploy != nil} {
			if set {
				kinds++
			}
		}
		if kinds != 1 {
			v.add(at, "write exactly one of commands (with image), build, scan or deploy")
			continue
		}
		kind := s.Kind()
		if kind != "commands" && (len(s.Env) > 0 || len(s.Secrets) > 0) {
			v.add(at, "env and secrets belong to commands steps")
		}
		if kind != "deploy" {
			executable++
			lastExecutable = i
		}
		switch kind {
		case "commands":
			v.commands(at, s)
		case "build":
			v.build(at, s.Build)
			if s.Name != "" {
				builds[s.Name] = i
			}
		case "scan":
			v.from(at, s.Scan.From, i, builds)
			if s.Scan.Severity != "" && !contains(Severities, s.Scan.Severity) {
				v.add(at, "severity must be one of %s", strings.Join(Severities, ", "))
			}
		case "deploy":
			d := s.Deploy
			v.from(at, d.From, i, builds)
			if !dnsLabel(d.Service, 63) {
				v.add(at, "deploy.service must be a DNS label")
			}
			if !dnsLabel(d.Env, 63) {
				v.add(at, "deploy.env must be a DNS label")
			}
			if d.Mode != "" && d.Mode != ModeAuto && d.Mode != ModeManual {
				v.add(at, "deploy.mode must be auto or manual")
			}
			if key := d.Service + "/" + d.Env; deployTargets[key] {
				v.add(at, "%s is deployed by an earlier step", key)
			} else {
				deployTargets[key] = true
			}
		}
	}
	if len(p.Steps) > 0 && executable == 0 {
		v.add("steps", "a pipeline needs a step that runs: commands, build or scan")
	}
	for i, s := range p.Steps {
		if s.Deploy != nil && i < lastExecutable {
			v.add(fmt.Sprintf("steps[%d] %s", i, s.Name), "deploy steps go last: they act after every other step passed")
		}
	}
	return v.err()
}

func (p *Pipeline) fillDefaults() {
	if p.Profile == "" {
		p.Profile = "default"
	}
	if p.Timeout == "" {
		p.Timeout = "60m"
	}
	for i := range p.Steps {
		s := &p.Steps[i]
		switch {
		case s.Build != nil:
			if s.Build.Context == "" {
				s.Build.Context = "."
			}
			if s.Build.Dockerfile == "" {
				s.Build.Dockerfile = path.Join(s.Build.Context, "Dockerfile")
			}
		case s.Scan != nil:
			if s.Scan.From == "" {
				s.Scan.From = p.onlyBuildBefore(i)
			}
			if s.Scan.Severity == "" {
				s.Scan.Severity = "HIGH"
			}
		case s.Deploy != nil:
			if s.Deploy.From == "" {
				s.Deploy.From = p.onlyBuildBefore(i)
			}
			if s.Deploy.Mode == "" {
				s.Deploy.Mode = ModeManual
			}
		}
	}
}

// Normalize fills the defaults of a pipeline built in code, such as
// Default, after checking it.
func (p *Pipeline) Normalize() error {
	if err := p.Validate(); err != nil {
		return err
	}
	p.fillDefaults()
	return nil
}

func (p *Pipeline) onlyBuildBefore(i int) string {
	name := ""
	for _, s := range p.Steps[:i] {
		if s.Build != nil {
			name = s.Name
		}
	}
	return name
}

// BuildStep returns the build step named name.
func (p *Pipeline) BuildStep(name string) *Build {
	for _, s := range p.Steps {
		if s.Name == name && s.Build != nil {
			return s.Build
		}
	}
	return nil
}

// ParseTimeout reads "<n>m" or "<n>h", from a minute to MaxTimeout.
func ParseTimeout(s string) (time.Duration, error) {
	if !timeoutRe.MatchString(s) {
		return 0, fmt.Errorf("%q is not <minutes>m or <hours>h", s)
	}
	n, _ := strconv.Atoi(s[:len(s)-1])
	d := time.Duration(n) * time.Minute
	if s[len(s)-1] == 'h' {
		d = time.Duration(n) * time.Hour
	}
	if d > MaxTimeout {
		return 0, fmt.Errorf("%s is above the limit of %s", s, MaxTimeout)
	}
	return d, nil
}

// Match reports whether an event starts this pipeline: kind is "push" or
// "pull_request", ref is the pushed branch or tag (refs/heads/…, refs/tags/…)
// or the pull request's target branch, defaultBranch the repository's.
func (p *Pipeline) Match(kind, ref, defaultBranch string) bool {
	if p.On == nil {
		switch kind {
		case "push":
			return ref == "refs/heads/"+defaultBranch
		case "pull_request":
			return true
		}
		return false
	}
	switch kind {
	case "push":
		t := p.On.Push
		if t == nil {
			return false
		}
		if branch, ok := strings.CutPrefix(ref, "refs/heads/"); ok {
			if len(t.Branches) == 0 && len(t.Tags) == 0 {
				return true
			}
			return matchAny(t.Branches, branch)
		}
		if tag, ok := strings.CutPrefix(ref, "refs/tags/"); ok {
			return matchAny(t.Tags, tag)
		}
	case "pull_request":
		t := p.On.PullRequest
		if t == nil {
			return false
		}
		return len(t.Branches) == 0 || matchAny(t.Branches, strings.TrimPrefix(ref, "refs/heads/"))
	}
	return false
}

func matchAny(patterns []string, s string) bool {
	for _, p := range patterns {
		if ok, _ := path.Match(p, s); ok {
			return true
		}
	}
	return false
}

var (
	dnsLabelRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	envNameRe  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	timeoutRe  = regexp.MustCompile(`^[1-9][0-9]{0,3}[mh]$`)
	// imageRe is a registry repository without a tag or digest:
	// [host[:port]/]path, lower case (the distribution reference grammar).
	imageRe  = regexp.MustCompile(`^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)+$`)
	targetRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
	// pathRe is a path inside the repository, the same rule as the schema's.
	pathRe = regexp.MustCompile(`^(\.|[^./,\\][^/,\\]*|\.[^./,\\][^/,\\]*|\.\.[^/,\\]+)(/(\.|[^./,\\][^/,\\]*|\.[^./,\\][^/,\\]*|\.\.[^/,\\]+))*/?$`)
	// stepImageRe is any image reference without white space.
	stepImageRe = regexp.MustCompile(`^[^\s]+$`)
)

func dnsLabel(s string, max int) bool { return len(s) <= max && dnsLabelRe.MatchString(s) }

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// ReservedEnv reports whether a variable name is one Kubeast sets.
func ReservedEnv(name string) bool { return name == "CI" || strings.HasPrefix(name, "KUBEAST_") }

type problems []string

func (v *problems) add(at, format string, args ...any) {
	*v = append(*v, at+": "+fmt.Sprintf(format, args...))
}

func (v problems) err() error {
	if len(v) == 0 {
		return nil
	}
	sort.Strings(v)
	return errors.New(strings.Join(v, "; "))
}

func (v *problems) patterns(at string, list []string) {
	if len(list) > MaxPatterns {
		v.add(at, "%d patterns, at most %d", len(list), MaxPatterns)
	}
	for _, p := range list {
		if p == "" || len(p) > MaxPatternLen {
			v.add(at, "a pattern is empty or longer than %d", MaxPatternLen)
			continue
		}
		if _, err := path.Match(p, ""); err != nil {
			v.add(at, "%q is not a valid pattern", p)
		}
	}
}

func (v *problems) env(at string, env map[string]string) {
	if len(env) > MaxEnv {
		v.add(at, "%d variables, at most %d", len(env), MaxEnv)
	}
	for name, value := range env {
		switch {
		case !envNameRe.MatchString(name):
			v.add(at, "%q is not a variable name", name)
		case ReservedEnv(name):
			v.add(at, "%s is set by Kubeast", name)
		}
		if len(value) > MaxEnvValueLen {
			v.add(at, "%s is longer than %d", name, MaxEnvValueLen)
		}
	}
}

func (v *problems) commands(at string, s Step) {
	switch {
	case s.Image == "":
		v.add(at, "a commands step needs an image")
	case len(s.Image) > MaxImageLen || !stepImageRe.MatchString(s.Image):
		v.add(at, "image %q is not an image reference", s.Image)
	}
	switch {
	case len(s.Commands) == 0:
		v.add(at, "a commands step needs commands")
	case len(s.Commands) > MaxCommands:
		v.add(at, "%d commands, at most %d", len(s.Commands), MaxCommands)
	}
	for _, c := range s.Commands {
		if strings.TrimSpace(c) == "" || len(c) > MaxCommandLen {
			v.add(at, "a command is empty or longer than %d", MaxCommandLen)
			break
		}
	}
	v.env(at+" env", s.Env)
	if len(s.Secrets) > MaxSecrets {
		v.add(at, "%d secrets, at most %d", len(s.Secrets), MaxSecrets)
	}
	seen := map[string]bool{}
	for _, name := range s.Secrets {
		switch {
		case !dnsLabel(name, MaxSecretName):
			v.add(at, "secret %q is not a DNS label of at most %d characters", name, MaxSecretName)
		case seen[name]:
			v.add(at, "secret %s is listed twice", name)
		}
		seen[name] = true
	}
}

func (v *problems) build(at string, b *Build) {
	if len(b.Image) > MaxImageLen || !imageRe.MatchString(b.Image) {
		v.add(at, "build.image must be a repository without a tag or digest (the tag is the commit), such as ghcr.io/org/app")
	}
	for field, p := range map[string]string{"build.context": b.Context, "build.dockerfile": b.Dockerfile} {
		if p != "" && !pathRe.MatchString(p) {
			v.add(at, "%s %q must stay inside the repository: no leading /, no .. segment, no comma or backslash", field, p)
		}
	}
	if b.Dockerfile != "" && path.Clean(b.Dockerfile) == "." {
		v.add(at, "build.dockerfile must name a file")
	}
	if b.Target != "" && (len(b.Target) > 63 || !targetRe.MatchString(b.Target)) {
		v.add(at, "build.target %q is not a stage name", b.Target)
	}
	if len(b.Args) > MaxBuildArgs {
		v.add(at, "%d build args, at most %d", len(b.Args), MaxBuildArgs)
	}
	for name, value := range b.Args {
		if !envNameRe.MatchString(name) {
			v.add(at, "build arg %q is not a name", name)
		}
		if len(value) > MaxEnvValueLen {
			v.add(at, "build arg %s is longer than %d", name, MaxEnvValueLen)
		}
	}
	if b.RegistrySecret != "" && !dnsLabel(b.RegistrySecret, MaxSecretName) {
		v.add(at, "build.registrySecret %q is not a DNS label of at most %d characters", b.RegistrySecret, MaxSecretName)
	}
}

// from checks the build step a scan or deploy step names, or finds the only
// one before it.
func (v *problems) from(at, from string, i int, builds map[string]int) {
	if from == "" {
		switch len(builds) {
		case 0:
			v.add(at, "needs a build step before it")
		case 1:
		default:
			v.add(at, "%d build steps come before it: say which with from", len(builds))
		}
		return
	}
	j, ok := builds[from]
	if !ok || j >= i {
		v.add(at, "from %q is not a build step before it", from)
	}
}
