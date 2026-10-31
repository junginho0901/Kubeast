// Package render turns a loaded Score workload and its environment's defaults
// into Kubernetes objects — the golden path. What a Score file leaves to the
// platform (replicas, security context, spread, addresses, budgets) comes from
// here and from the environment, never from the developer's file.
//
// Objects are plain maps, the form the patches and the gate work on, built in
// a fixed order so the same input gives the same bytes.
package render

import (
	"bytes"
	"errors"
	"fmt"
	"sort"

	"github.com/score-spec/score-go/framework"
	"github.com/score-spec/score-go/types"
	"gopkg.in/yaml.v3"

	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/spec"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/target"
)

// Object is one Kubernetes object.
type Object = map[string]interface{}

// Input is one workload in one environment.
type Input struct {
	Spec *spec.Spec
	Env  *target.Env
	// Peers are the other workloads of the environment for service-port
	// resources: workload name → service port name → port.
	Peers map[string]map[string]int
}

// Result is the rendered objects in apply order, with notes on what was left
// out and why (shown with the service, never dropped silently).
type Result struct {
	Objects []Object
	Notes   []string
}

const (
	labelName      = "app.kubernetes.io/name"
	labelManagedBy = "app.kubernetes.io/managed-by"
	labelService   = spec.Prefix + "service"
	labelEnv       = spec.Prefix + "environment"
	// annOwner marks the object's owner the way Argo CD's tracking-id does:
	// <env>/<service>/<kind>/<name>, naming the object itself, so a copy of
	// the annotation on another object does not claim it. Sync leaves alone
	// any object whose owner is not the workload it syncs.
	annOwner     = spec.Prefix + "owner"
	annFilesHash = spec.Prefix + "files-hash"
	managedBy    = "kubeast-deploy"
)

type renderer struct {
	in   Input
	w    *types.Workload
	ext  spec.Ext
	env  *target.Env
	name string
	ns   string

	objects []Object
	notes   []string
	errs    []error

	outputs     map[string]framework.OutputLookupFunc
	lookup      func(string) (string, error)
	volumes     map[string]Object
	usedVolumes map[string]bool
	secrets     map[string]*secretRes
	sa          *saRes
	needTmp     bool
}

// Render builds the objects. Every problem found is returned together.
func Render(in Input) (*Result, error) {
	if in.Spec == nil || in.Env == nil {
		return nil, errors.New("render: a spec and an environment are required")
	}
	r := &renderer{
		in:          in,
		w:           &in.Spec.Workload,
		ext:         in.Spec.Ext,
		env:         in.Env,
		outputs:     map[string]framework.OutputLookupFunc{},
		volumes:     map[string]Object{},
		usedVolumes: map[string]bool{},
		secrets:     map[string]*secretRes{},
	}
	r.lookup = framework.BuildSubstitutionFunction(r.w.Metadata, r.outputs)
	r.run()
	if len(r.errs) > 0 {
		return nil, errors.Join(r.errs...)
	}
	sortObjects(r.objects)
	return &Result{Objects: r.objects, Notes: r.notes}, nil
}

func (r *renderer) run() {
	r.name = r.in.Spec.Name()
	ns, err := r.env.NamespaceFor(r.name)
	if err != nil {
		r.fail("%v", err)
		return
	}
	r.ns = ns
	r.notes = append(r.notes, r.in.Spec.Notes...)

	profile := r.profile()
	r.provision()
	if len(r.errs) > 0 {
		return // the steps below read the resources' outputs
	}
	files := r.files()
	containers := r.containers(files)
	r.serviceAccount()
	r.externalSecrets() // after the containers: they decide which keys are used
	r.service()
	r.deployment(containers, files, profile)
	r.autoscaler()
	r.disruptionBudget()
	r.serviceMonitor()
}

func (r *renderer) fail(format string, args ...interface{}) {
	r.errs = append(r.errs, fmt.Errorf(format, args...))
}

func (r *renderer) note(format string, args ...interface{}) {
	r.notes = append(r.notes, fmt.Sprintf(format, args...))
}

// labels are on every object and on the pods.
func (r *renderer) labels() Object {
	return Object{
		labelName:      r.name,
		labelManagedBy: managedBy,
		labelService:   r.name,
		labelEnv:       r.env.Name,
	}
}

func (r *renderer) selector() Object {
	return Object{labelName: r.name}
}

func (r *renderer) meta(kind, name string, annotations Object) Object {
	ann := Object{annOwner: fmt.Sprintf("%s/%s/%s/%s", r.env.Name, r.name, kind, name)}
	for k, v := range annotations {
		ann[k] = v
	}
	return Object{
		"name":        name,
		"namespace":   r.ns,
		"labels":      r.labels(),
		"annotations": ann,
	}
}

func (r *renderer) add(apiVersion, kind, name string, annotations Object, fields Object) {
	obj := Object{"apiVersion": apiVersion, "kind": kind, "metadata": r.meta(kind, name, annotations)}
	for k, v := range fields {
		obj[k] = v
	}
	r.objects = append(r.objects, obj)
}

func (r *renderer) profile() *target.Profile {
	name := r.ext.Profile
	if name == "" {
		name = r.env.DefaultProfile
	}
	if name == "" {
		return nil
	}
	p, ok := r.env.Profiles[name]
	if !ok {
		r.fail("annotation %s: %q is not a profile of environment %q (%v)", spec.KeyProfile, name, r.env.Name, r.env.ProfileNames())
		return nil
	}
	return &p
}

func (r *renderer) replicas() int {
	if r.ext.Replicas != nil {
		return *r.ext.Replicas
	}
	return r.env.Replicas
}

// kindOrder is the apply order: what others refer to first.
var kindOrder = map[string]int{
	"ServiceAccount":          0,
	"ConfigMap":               1,
	"ExternalSecret":          2,
	"Service":                 3,
	"Deployment":              4,
	"HorizontalPodAutoscaler": 5,
	"PodDisruptionBudget":     6,
	"HTTPRoute":               7,
	"ServiceMonitor":          8,
}

func sortObjects(objs []Object) {
	sort.SliceStable(objs, func(i, j int) bool {
		ki, kj := objs[i]["kind"].(string), objs[j]["kind"].(string)
		oi, oki := kindOrder[ki]
		oj, okj := kindOrder[kj]
		if !oki {
			oi = len(kindOrder)
		}
		if !okj {
			oj = len(kindOrder)
		}
		if oi != oj {
			return oi < oj
		}
		if ki != kj {
			return ki < kj
		}
		return objName(objs[i]) < objName(objs[j])
	})
}

func objName(o Object) string {
	m, _ := o["metadata"].(Object)
	n, _ := m["name"].(string)
	return n
}

// YAML writes the objects as one multi-document YAML stream, keys sorted.
// yaml.v3 writes maps directly; going through JSON (sigs.k8s.io/yaml) took
// twice as long and three times the allocations for the same documents.
func (res *Result) YAML() ([]byte, error) {
	var b bytes.Buffer
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	for _, o := range res.Objects {
		if err := enc.Encode(o); err != nil {
			return nil, fmt.Errorf("%s %s: %w", o["kind"], objName(o), err)
		}
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func strList(in []string) []interface{} {
	out := make([]interface{}, len(in))
	for i, s := range in {
		out[i] = s
	}
	return out
}
