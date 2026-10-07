package handler

import (
	"bytes"
	"encoding/json"
	"io"
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
}

// gitopsTargets reads the objects a write request addresses from its path
// (or, for the YAML apply paths, from the manifest in its body). Writes that
// create objects or do not address a tracked object (Helm, search, YAML
// create) yield nothing. The body is put back for the handler.
func gitopsTargets(r *http.Request) ([]gitopsTarget, error) {
	p := strings.TrimPrefix(r.URL.Path, "/api/v1/")
	seg := strings.Split(strings.Trim(p, "/"), "/")
	switch {
	case len(seg) == 0 || seg[0] == "helm" || seg[0] == "search":
		return nil, nil
	case seg[0] == "resources":
		if len(seg) == 3 && seg[1] == "yaml" && seg[2] == "apply" {
			return gitopsTargetsFromBody(r, "")
		}
		return nil, nil // yaml/create makes new objects
	case seg[0] == "custom-resources" && len(seg) == 6:
		ns := seg[4]
		if ns == "-" {
			ns = ""
		}
		return []gitopsTarget{{group: seg[1], version: seg[2], plural: seg[3], namespace: ns, name: seg[5]}}, nil
	case seg[0] == "namespaces":
		switch {
		case len(seg) == 1: // POST /namespaces: a new object
			return nil, nil
		case len(seg) == 2: // DELETE /namespaces/{name}
			return []gitopsTarget{{resourceType: "namespaces", name: seg[1]}}, nil
		case len(seg) == 4 && seg[2] == "yaml" && seg[3] == "apply":
			return gitopsTargetsFromBody(r, seg[1])
		case len(seg) >= 4: // /namespaces/{ns}/{plural}/{name}[/action]
			return []gitopsTarget{{resourceType: seg[2], namespace: seg[1], name: seg[3]}}, nil
		}
		return nil, nil
	case len(seg) == 4 && seg[2] == "yaml" && seg[3] == "apply": // /nodes/{name}/yaml/apply
		return gitopsTargetsFromBody(r, "")
	case len(seg) >= 2: // cluster-scoped: /{plural}/{name}[/action]
		return []gitopsTarget{{resourceType: seg[0], name: seg[1]}}, nil
	}
	return nil, nil
}

// gitopsTargetsFromBody reads {"yaml": "..."} and names every document in it
// that already has a kind and a name; the request body is restored.
func gitopsTargetsFromBody(r *http.Request, defaultNS string) ([]gitopsTarget, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	var body struct {
		Namespace string `json:"namespace"`
		YAML      string `json:"yaml"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, nil // the handler answers 400 itself
	}
	if body.Namespace != "" {
		defaultNS = body.Namespace
	}
	var out []gitopsTarget
	for _, doc := range strings.Split(body.YAML, "\n---") {
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
		out = append(out, gitopsTarget{apiVersion: m.APIVersion, kind: m.Kind, namespace: ns, name: m.Metadata.Name})
	}
	return out, nil
}

// GitopsGuard refuses (409) a write to an object an Argo CD Application
// manages while gitops.argocd.mode is "block"; in "warn" mode the UI asks
// first and the request passes. Registered on the write routes only when
// the guard is enabled.
func (h *Handler) GitopsGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		cfg := h.svc.Gitops()
		if !cfg.Blocks() {
			next.ServeHTTP(w, r)
			return
		}
		targets, err := gitopsTargets(r)
		if err != nil {
			response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
			return
		}
		for _, t := range targets {
			var res gitops.Result
			switch {
			case t.kind != "":
				res, err = h.svc.GitopsManagedGVK(r.Context(), t.apiVersion, t.kind, t.namespace, t.name)
			case t.plural != "":
				res, err = h.svc.GitopsManagedCustom(r.Context(), t.group, t.version, t.plural, t.namespace, t.name)
			default:
				res, err = h.svc.GitopsManaged(r.Context(), t.resourceType, t.namespace, t.name)
			}
			if err != nil {
				// The lookup failed (unknown type, cluster unreachable): the handler
				// reports that on its own terms.
				slog.Warn("gitops guard: lookup failed, letting the write through", "path", r.URL.Path, "err", err)
				continue
			}
			if res.Managed {
				slog.Info("gitops guard: write refused", "path", r.URL.Path, "method", r.Method, "app", res.App, "by", res.Method)
				response.Error(w, http.StatusConflict, "managed by Argo CD application "+res.App+"; change it in Git")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
