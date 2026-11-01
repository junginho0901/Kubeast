package render

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/score-spec/score-go/framework"
	"go.yaml.in/yaml/v3"
)

// The escape hatch for what a Score file and the environment cannot say:
// patches change rendered objects, raw files add objects the renderer does
// not make. Both run before the gate, which checks the result the same way.

// File is one patches or raw file, named in error messages.
type File struct {
	Name string
	Data []byte
}

// Patch is one operation of a patches file: score-k8s's set and delete on a
// dot path (score-go's syntax: list indexes as numbers, -1 appends, `\.`
// escapes a dot in a key), aimed at rendered objects by kind and optional
// name rather than by position. No templates run on the server.
type Patch struct {
	Target      PatchTarget `yaml:"target"`
	Op          string      `yaml:"op"`
	Path        string      `yaml:"path"`
	Value       interface{} `yaml:"value"`
	Description string      `yaml:"description"`
}

// PatchTarget selects the rendered objects a patch applies to.
type PatchTarget struct {
	Kind string `yaml:"kind"`
	Name string `yaml:"name"`
}

// protectedPaths are what sync and the other objects rely on: identity, the
// owner annotation, the labels the selectors use and the selectors.
var protectedPaths = [][]string{
	{"apiVersion"}, {"kind"},
	{"metadata", "name"}, {"metadata", "namespace"}, {"metadata", "generateName"},
	{"metadata", "annotations", annOwner},
	{"metadata", "labels", labelName}, {"metadata", "labels", labelManagedBy},
	{"metadata", "labels", labelService}, {"metadata", "labels", labelEnv},
	{"spec", "selector"},
	{"spec", "template", "metadata", "labels"},
}

func protectedPath(parts []string) string {
	for _, p := range protectedPaths {
		n := min(len(p), len(parts))
		same := true
		for i := 0; i < n; i++ {
			if p[i] != parts[i] {
				same = false
				break
			}
		}
		if same {
			return strings.Join(p, ".")
		}
	}
	return ""
}

// checkPath finds what score-go's OverridePathInMap would not report: a list
// index out of range in the middle of a path (it panics there), a delete of
// a path that is not there (it is silent, and leaves empty maps behind) and
// a list created as a map from a missing parent.
func checkPath(obj map[string]interface{}, parts []string, del bool) error {
	var cur interface{} = obj
	for i, p := range parts {
		at := strings.Join(parts[:i], ".")
		switch c := cur.(type) {
		case map[string]interface{}:
			v, ok := c[p]
			if !ok {
				if del {
					return fmt.Errorf("%s does not exist", strings.Join(parts[:i+1], "."))
				}
				for _, rest := range parts[i+1:] {
					if _, err := strconv.Atoi(rest); err == nil {
						return fmt.Errorf("%s does not exist; set the list itself", strings.Join(parts[:i+1], "."))
					}
				}
				return nil
			}
			cur = v
		case []interface{}:
			n, err := strconv.Atoi(p)
			if err != nil {
				return fmt.Errorf("%s is a list; %q is not an index", at, p)
			}
			if i == len(parts)-1 && !del && n == -1 {
				return nil
			}
			if n < 0 || n >= len(c) {
				return fmt.Errorf("%s has %d items; index %d is out of range", at, len(c), n)
			}
			cur = c[n]
		default:
			return fmt.Errorf("%s is a value, not a map or a list", at)
		}
	}
	return nil
}

func (r *renderer) applyPatches(files []File) {
	for _, f := range files {
		var ops []Patch
		dec := yaml.NewDecoder(bytes.NewReader(f.Data))
		dec.KnownFields(true)
		if err := dec.Decode(&ops); err != nil && !errors.Is(err, io.EOF) {
			r.fail("patches %s: %v", f.Name, err)
			continue
		}
		for i, p := range ops {
			where := fmt.Sprintf("patches %s #%d", f.Name, i+1)
			switch {
			case p.Op != "set" && p.Op != "delete":
				r.fail("%s: op %q is not set or delete", where, p.Op)
				continue
			case p.Target.Kind == "":
				r.fail("%s: target.kind is required", where)
				continue
			case p.Path == "":
				r.fail("%s: path is required", where)
				continue
			case p.Op == "set" && p.Value == nil:
				r.fail("%s: set needs a value (delete removes)", where)
				continue
			}
			parts := framework.ParseDotPathParts(p.Path)
			if prot := protectedPath(parts); prot != "" {
				r.fail("%s: %s is the platform's and cannot be patched", where, prot)
				continue
			}
			matched := 0
			for j, o := range r.objects {
				if o["kind"] != p.Target.Kind || (p.Target.Name != "" && objName(o) != p.Target.Name) {
					continue
				}
				matched++
				if err := checkPath(o, parts, p.Op == "delete"); err != nil {
					r.fail("%s on %s %s: %v", where, p.Target.Kind, objName(o), err)
					continue
				}
				out, err := framework.OverridePathInMap(o, parts, p.Op == "delete", p.Value)
				if err != nil {
					r.fail("%s on %s %s: %v", where, p.Target.Kind, objName(o), err)
					continue
				}
				r.objects[j] = out
			}
			if matched == 0 {
				target := p.Target.Kind
				if p.Target.Name != "" {
					target += " " + p.Target.Name
				}
				r.fail("%s: no rendered %s", where, target)
			}
		}
	}
}

// clusterScoped are the kinds a raw file may hold that have no namespace.
// They are not applied with the workload's identity: they wait for a
// platform admin's approval and go with the platform identity. A custom
// resource not listed here counts as namespaced until sync asks the cluster.
var clusterScoped = map[string]bool{
	"Namespace": true, "Node": true, "PersistentVolume": true,
	"ClusterRole": true, "ClusterRoleBinding": true,
	"CustomResourceDefinition": true, "APIService": true,
	"StorageClass": true, "CSIDriver": true, "VolumeAttachment": true,
	"PriorityClass": true, "RuntimeClass": true, "IngressClass": true, "GatewayClass": true,
	"ValidatingWebhookConfiguration": true, "MutatingWebhookConfiguration": true,
	"ValidatingAdmissionPolicy": true, "ValidatingAdmissionPolicyBinding": true,
	"DeviceClass": true, "ClusterSecretStore": true, "ClusterIssuer": true,
}

func (r *renderer) addRaw(files []File) {
	seen := map[string]bool{}
	for _, o := range r.objects {
		seen[o["kind"].(string)+"/"+objName(o)] = true
	}
	for _, f := range files {
		dec := yaml.NewDecoder(bytes.NewReader(f.Data))
		for n := 1; ; n++ {
			var doc map[string]interface{}
			err := dec.Decode(&doc)
			if errors.Is(err, io.EOF) {
				break
			}
			where := fmt.Sprintf("raw %s document %d", f.Name, n)
			if err != nil {
				r.fail("%s: %v", where, err)
				break
			}
			if doc == nil {
				continue
			}
			r.addRawObject(where, doc, seen)
		}
	}
}

func (r *renderer) addRawObject(where string, doc map[string]interface{}, seen map[string]bool) {
	apiVersion, _ := doc["apiVersion"].(string)
	kind, _ := doc["kind"].(string)
	md, _ := doc["metadata"].(map[string]interface{})
	name, _ := md["name"].(string)
	switch {
	case apiVersion == "" || kind == "" || name == "":
		r.fail("%s: needs apiVersion, kind and metadata.name", where)
		return
	case kind == "Secret":
		r.fail("%s: a Secret's values would sit in the source; use a secret resource (External Secrets)", where)
		return
	case kind == "List" || strings.HasSuffix(kind, "List"):
		r.fail("%s: write the items as separate documents, not a %s", where, kind)
		return
	}
	if ns, ok := md["namespace"].(string); ok && ns != "" && ns != r.ns {
		r.fail("%s: namespace %q; the workload's objects stay in %q", where, ns, r.ns)
		return
	}
	key := kind + "/" + name
	if seen[key] {
		r.fail("%s: %s %s is already rendered or listed; change a rendered object with patches", where, kind, name)
		return
	}
	seen[key] = true

	labels, _ := md["labels"].(map[string]interface{})
	if labels == nil {
		labels = map[string]interface{}{}
	}
	for k, v := range r.labels() {
		if old, ok := labels[k]; ok && old != v {
			r.fail("%s: label %s is the platform's (%v), not %v", where, k, v, old)
			return
		}
		labels[k] = v
	}
	md["labels"] = labels
	ann, _ := md["annotations"].(map[string]interface{})
	if ann == nil {
		ann = map[string]interface{}{}
	}
	if _, ok := ann[annOwner]; ok {
		r.fail("%s: annotation %s is the platform's", where, annOwner)
		return
	}
	ann[annOwner] = fmt.Sprintf("%s/%s/%s/%s", r.env.Name, r.name, kind, name)
	md["annotations"] = ann

	if clusterScoped[kind] {
		delete(md, "namespace")
		r.clusterScoped = append(r.clusterScoped, doc)
		r.note("%s: %s %s is cluster-scoped; it waits for a platform admin's approval", where, kind, name)
		return
	}
	md["namespace"] = r.ns
	r.objects = append(r.objects, doc)
}
