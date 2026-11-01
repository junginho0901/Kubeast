// Package plan puts the deploy steps together for one workload in one
// environment: read it from a source, render it, check it with the gate.
// The result is what a sync would apply and whether it may.
package plan

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"

	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/gate"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/render"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/source"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/spec"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/target"
)

// Options carries what the source does not hold.
type Options struct {
	// Approved are the policy exceptions a platform admin approved for
	// this workload.
	Approved map[string]bool
}

// Plan is one workload in one environment, rendered and checked.
type Plan struct {
	Service  string
	Env      string
	Revision string
	Result   *render.Result
	Report   gate.Report
}

// Blocked reports whether the gate stops this plan.
func (p *Plan) Blocked() bool { return p.Report.Blocked() }

// Planner builds plans from one source. It keeps a gate per environment
// (a gate takes 0.1 s to build and is safe to share) and builds it again
// when the environment's defaults or the policies change.
type Planner struct {
	src   source.Source
	mu    sync.Mutex
	gates map[string]gateEntry
}

type gateEntry struct {
	key  string
	gate *gate.Gate
}

// New returns a planner over src. Close releases its gates.
func New(src source.Source) *Planner {
	return &Planner{src: src, gates: map[string]gateEntry{}}
}

// Close releases the gates.
func (p *Planner) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	var errs []error
	for env, e := range p.gates {
		errs = append(errs, e.gate.Close())
		delete(p.gates, env)
	}
	return errors.Join(errs...)
}

// Build reads, renders and checks one workload in one environment.
func (p *Planner) Build(ctx context.Context, service, envName string, opts Options) (*Plan, error) {
	b, err := p.src.Load(ctx, service, envName)
	if err != nil {
		return nil, err
	}
	env, err := target.Parse(b.Defaults)
	if err != nil {
		return nil, fmt.Errorf("environments/%s/_defaults.yaml: %w", envName, err)
	}
	if env.Name != envName {
		return nil, fmt.Errorf("environments/%s/_defaults.yaml names environment %q", envName, env.Name)
	}
	s, err := load(b)
	if err != nil {
		return nil, fmt.Errorf("services/%s: %w", service, err)
	}
	if s.Name() != service {
		return nil, fmt.Errorf("services/%s/score.yaml: metadata.name is %q; it must be the folder's name", service, s.Name())
	}
	peers, err := p.peers(ctx, s, env.Name)
	if err != nil {
		return nil, err
	}
	res, err := render.Render(render.Input{
		Spec:    s,
		Env:     env,
		Peers:   peers,
		Patches: renderFiles(b.Patches),
		Raw:     renderFiles(b.Raw),
	})
	if err != nil {
		return nil, fmt.Errorf("services/%s in %s: %w", service, envName, err)
	}
	g, err := p.gate(ctx, env, b)
	if err != nil {
		return nil, err
	}
	objs := make([]map[string]interface{}, 0, len(res.Objects)+len(res.ClusterScoped))
	for _, o := range res.Objects {
		objs = append(objs, o)
	}
	for _, o := range res.ClusterScoped {
		objs = append(objs, o)
	}
	rep, err := g.Check(ctx, gate.Input{Objects: objs, Exceptions: s.Ext.PolicyExceptions, Approved: opts.Approved})
	if err != nil {
		return nil, err
	}
	return &Plan{Service: service, Env: envName, Revision: b.Revision, Result: res, Report: rep}, nil
}

func load(b *source.Bundle) (*spec.Spec, error) {
	in := spec.Input{Score: b.Score, Files: b.Files}
	if b.Overrides != nil {
		in.Overrides = [][]byte{b.Overrides}
	}
	return spec.Load(in)
}

// peers reads only the workloads this one names in service-port resources,
// as the same environment sees them, for their service ports. A workload
// that does not exist is left out; the renderer then says so.
func (p *Planner) peers(ctx context.Context, s *spec.Spec, env string) (map[string]map[string]int, error) {
	out := map[string]map[string]int{}
	for _, r := range s.Workload.Resources {
		if r.Type != "service-port" {
			continue
		}
		w, _ := r.Params["workload"].(string)
		if w == "" || w == s.Name() || out[w] != nil {
			continue
		}
		b, err := p.src.Load(ctx, w, env)
		if errors.Is(err, source.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("service-port peer %s: %w", w, err)
		}
		ps, err := load(b)
		if err != nil {
			return nil, fmt.Errorf("service-port peer services/%s: %w", w, err)
		}
		ports := map[string]int{}
		if ps.Workload.Service != nil {
			for n, port := range ps.Workload.Service.Ports {
				ports[n] = port.Port
			}
		}
		out[w] = ports
	}
	return out, nil
}

// gate returns the environment's gate, built again when its defaults or the
// policies changed since it was built.
func (p *Planner) gate(ctx context.Context, env *target.Env, b *source.Bundle) (*gate.Gate, error) {
	h := sha256.New()
	h.Write(b.Defaults)
	for _, f := range b.Policies {
		fmt.Fprintf(h, "\x00%s\x00%d\x00", f.Name, len(f.Data))
		h.Write(f.Data)
	}
	key := hex.EncodeToString(h.Sum(nil))

	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.gates[env.Name]; ok {
		if e.key == key {
			return e.gate, nil
		}
		e.gate.Close()
		delete(p.gates, env.Name)
	}
	policies := make([]gate.File, len(b.Policies))
	for i, f := range b.Policies {
		policies[i] = gate.File{Name: f.Name, Data: f.Data}
	}
	g, err := gate.New(ctx, gate.ConfigFor(env, policies))
	if err != nil {
		return nil, fmt.Errorf("gate for %s: %w", env.Name, err)
	}
	p.gates[env.Name] = gateEntry{key: key, gate: g}
	return g, nil
}

func renderFiles(in []source.File) []render.File {
	out := make([]render.File, len(in))
	for i, f := range in {
		out[i] = render.File{Name: f.Name, Data: f.Data}
	}
	return out
}
