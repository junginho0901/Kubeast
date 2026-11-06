package handler

import (
	"errors"
	"fmt"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"log/slog"
	"net/http"
	"strings"

	"sigs.k8s.io/yaml"

	"github.com/junginho0901/kubeast/services/pkg/gitops"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// gitopsTarget is one object a write request is about to change.
type gitopsTarget struct {
	resourceType, namespace, name string // Kubeast path spelling
	apiVersion, kind              string // set for YAML bodies instead of resourceType
	group, version, plural        string // set for custom-resource paths
	inBody                        bool   // named in a YAML body: the write goes to the address, whatever the body says
}

// gitopsNoObject are the first path segments of write routes that change no tracked object.
var gitopsNoObject = map[string]bool{"helm": true, "search": true, "hygiene": true, "alertstore": true}

// gitopsTargets reads the objects a write request addresses from its path or,
// for the routes that name their object in the body, from the body as the
// handler reads it. A YAML apply also yields what its YAML says of itself.
// Writes that create objects or do not address a tracked object (Helm, search,
// YAML create) yield nothing. The body is left for the handler.
func gitopsTargets(r *http.Request) []gitopsTarget {
	p := strings.TrimPrefix(r.URL.Path, "/api/v1/")
	seg := strings.Split(strings.Trim(p, "/"), "/")
	switch {
	case len(seg) == 0 || gitopsNoObject[seg[0]]:
		return nil
	case seg[0] == "resources":
		if len(seg) == 3 && seg[1] == "yaml" && seg[2] == "apply" {
			return gitopsTargetsFromApply(r)
		}
		return nil // yaml/create makes new objects
	case seg[0] == "custom-resources" && len(seg) == 6:
		ns := seg[4]
		if ns == "-" {
			ns = ""
		}
		return []gitopsTarget{{group: seg[1], version: seg[2], plural: seg[3], namespace: ns, name: seg[5]}}
	case seg[0] == "namespaces":
		switch {
		case len(seg) == 1: // POST /namespaces: a new object
			return nil
		case len(seg) == 2: // DELETE /namespaces/{name}
			return []gitopsTarget{{resourceType: "namespaces", name: seg[1]}}
		case len(seg) == 4 && seg[2] == "yaml" && seg[3] == "apply":
			return append(gitopsTargetsFromBody(r, seg[1]), gitopsTarget{resourceType: "namespaces", name: seg[1]})
		case len(seg) == 4 && seg[2] == "optimization" && seg[3] == "resize":
			return gitopsTargetsFromResize(r, seg[1])
		case len(seg) >= 4: // /namespaces/{ns}/{plural}/{name}[/action]
			return []gitopsTarget{{resourceType: seg[2], namespace: seg[1], name: seg[3]}}
		}
		return nil
	case len(seg) == 4 && seg[2] == "yaml" && seg[3] == "apply": // /nodes/{name}/yaml/apply
		return append(gitopsTargetsFromBody(r, ""), gitopsTarget{resourceType: seg[0], name: seg[1]})
	case len(seg) >= 2: // cluster-scoped: /{plural}/{name}[/action]
		return []gitopsTarget{{resourceType: seg[0], name: seg[1]}}
	}
	return nil
}

// gitopsTargetsFromApply is POST /resources/yaml/apply: the patch goes to the
// object the JSON names. Its YAML comes first so a request carrying the object's
// own manifest keeps the row it always had.
func gitopsTargetsFromApply(r *http.Request) []gitopsTarget {
	var body applyYAMLBody
	if !peekJSON(r, &body) {
		return nil // the handler's 400
	}
	name := body.Name
	if name == "" {
		name = body.ResourceName
	}
	return append(gitopsTargetsInYAML(body.YAML, body.Namespace), gitopsTarget{resourceType: body.ResourceType, namespace: body.Namespace, name: name})
}

// gitopsTargetsFromBody reads {"yaml": "..."}; the request body is restored.
func gitopsTargetsFromBody(r *http.Request, defaultNS string) []gitopsTarget {
	var body struct {
		Namespace string `json:"namespace"`
		YAML      string `json:"yaml"`
	}
	if !peekJSON(r, &body) {
		return nil // the handler answers 400 itself
	}
	if body.Namespace != "" {
		defaultNS = body.Namespace
	}
	return gitopsTargetsInYAML(body.YAML, defaultNS)
}

// gitopsTargetsInYAML names every document that already has a kind and a name.
func gitopsTargetsInYAML(manifest, defaultNS string) []gitopsTarget {
	var out []gitopsTarget
	for _, doc := range strings.Split(manifest, "\n---") {
		var m struct {
			APIVersion string `json:"apiVersion"`
			Kind       string `json:"kind"`
			Metadata   struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
		}
		if err := yaml.Unmarshal([]byte(doc), &m); err != nil || m.Kind == "" || m.Metadata.Name == "" {
			continue
		}
		ns := m.Metadata.Namespace
		if ns == "" {
			ns = defaultNS
		}
		out = append(out, gitopsTarget{apiVersion: m.APIVersion, kind: m.Kind, namespace: ns, name: m.Metadata.Name, inBody: true})
	}
	return out
}

// gitopsTargetsFromResize names the workload a resize request addresses
// ({"kind","name"} in the body): its pods carry no tracking annotation, the
// workload does. The request body is restored.
func gitopsTargetsFromResize(r *http.Request, ns string) []gitopsTarget {
	var body struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	if !peekJSON(r, &body) || body.Name == "" {
		return nil // the handler answers 400 itself
	}
	apiVersion := map[string]string{"Deployment": "apps/v1", "StatefulSet": "apps/v1", "DaemonSet": "apps/v1", "ReplicaSet": "apps/v1", "Job": "batch/v1", "CronJob": "batch/v1", "Pod": "v1"}[body.Kind]
	if apiVersion == "" {
		return nil
	}
	return []gitopsTarget{{apiVersion: apiVersion, kind: body.Kind, namespace: ns, name: body.Name}}
}

// gitopsRouteIsOff says a route whose feature is switched off will change nothing: its handler's 404 is the answer,
// whoever asks and whatever it names.
func (h *Handler) gitopsRouteIsOff(r *http.Request) bool {
	return !h.cfg.InPlaceResizeEnabled && strings.HasSuffix(strings.TrimRight(r.URL.Path, "/"), "/optimization/resize")
}

// GitopsGuard refuses (409) a write to an object an Argo CD Application
// manages while gitops.argocd.mode is "block"; in "warn" mode the UI asks
// first and the request passes. A target it cannot read is refused too, since
// it cannot say the write is allowed. Someone without the route's permission
// gets the handler's answer first, so the guard tells them nothing and leaves
// no refusal. Registered on the write routes only when the guard is enabled.
func (h *Handler) GitopsGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		cfg := h.svc.Gitops()
		if !cfg.Blocks() || h.gitopsRouteIsOff(r) {
			next.ServeHTTP(w, r)
			return
		}
		targets := gitopsTargets(r)
		if len(targets) == 0 {
			next.ServeHTTP(w, r)
			return
		}
		if err := h.gitopsRoutePermission(r); err != nil {
			h.handleError(w, err)
			return
		}
		for _, t := range targets {
			var res gitops.Result
			var err error
			switch {
			case t.kind != "":
				res, err = h.svc.GitopsManagedGVK(r.Context(), t.apiVersion, t.kind, t.namespace, t.name)
			case t.plural != "":
				res, err = h.svc.GitopsManagedCustom(r.Context(), t.group, t.version, t.plural, t.namespace, t.name)
			default:
				res, err = h.svc.GitopsManaged(r.Context(), t.resourceType, t.namespace, t.name)
			}
			kind := t.kind
			if kind == "" {
				kind = t.resourceType
			}
			if kind == "" {
				kind = t.plural
			}
			if err != nil {
				if t.inBody {
					continue // the address decides, and it is checked on its own
				}
				err = fmt.Errorf("could not check whether Argo CD manages %s %s/%s, so the write was refused: %w", kind, t.namespace, t.name, err)
				slog.Warn("gitops guard: lookup failed, write refused", "path", r.URL.Path, "method", r.Method, "err", err)
				h.recordAuditWithPayload(r, "k8s.gitops.refuse", kind, t.name, t.namespace, err, nil,
					audit.MustJSON(map[string]interface{}{"method": r.Method, "path": r.URL.Path, "lookup_failed": true}))
				h.handleError(w, err)
				return
			}
			if res.Managed {
				slog.Info("gitops guard: write refused", "path", r.URL.Path, "method", r.Method, "app", res.App, "by", res.Method)
				msg := "managed by Argo CD application " + res.App + "; change it in Git"
				h.recordAuditWithPayload(r, "k8s.gitops.refuse", kind, t.name, t.namespace, errors.New(msg), nil,
					audit.MustJSON(map[string]interface{}{"app": res.App, "method": r.Method, "path": r.URL.Path, "by": res.Method}))
				response.Error(w, http.StatusConflict, msg)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
