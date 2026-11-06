package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// NamespaceScopeMiddleware holds a request to the namespaces it may reach, before any cluster call: a namespace-scoped
// grant (the token's "ns" claim) to its namespaces, and everyone to the guarded namespaces (services/pkg/protectedns).
// It is the one place that decides: the matched route picks its rule in namespaceRoutes, a {namespace} in the path is
// checked without an entry, and a route with neither is refused to a limited grant, so a new route is closed until
// someone says how it stays inside. Runs after ClusterMiddleware, in an inline group so the route is already matched.
func (h *Handler) NamespaceScopeMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, ok := auth.FromContext(r.Context())
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		id, _ := cluster.FromContext(r.Context())
		scope := payload.Namespaces[string(id)]
		// A global admin passes the guarded namespaces, and without a limited grant has nothing else to check.
		protected := h.svc.ProtectedNamespaces(r.Context())
		if len(scope) == 0 && (protected == (protectedns.Namespaces{}) || auth.MatchAny(payload.Perms["*"], "*")) {
			next.ServeHTTP(w, r)
			return
		}
		pattern := routePattern(r)
		ask := namespaceRuleFor(r.Method, pattern).ask(h, r)
		var targetType, target string
		var err error
		permission := "namespace scope"
		details := map[string]interface{}{"method": r.Method, "path": r.URL.Path}
		if len(scope) > 0 {
			details["namespaces"] = scope
			targetType, target, err = ask.refusal(payload, string(id), scope)
		}
		if err == nil && len(ask.namespaces) > 0 {
			if targetType, target, err = ask.protectedRefusal(protected, payload, string(id), h.protectedAct(r, pattern)); err != nil {
				permission = "protected namespace"
				delete(details, "namespaces")
			}
		}
		if err == nil {
			next.ServeHTTP(w, r)
			return
		}
		details["permission"] = permission
		// A write or a terminal is a refused attempt worth a row; reads are not (see denied).
		if r.Method != http.MethodGet || strings.HasSuffix(r.URL.Path, "/ws") {
			_ = h.recordAuditWithPayload(r, "k8s.access.denied", targetType, target, "", err, nil, audit.MustJSON(details))
		}
		if permission == "protected namespace" {
			// The screens say why from this: no role on the cluster would change the answer.
			response.JSON(w, http.StatusForbidden, map[string]string{"detail": err.Error(), "reason": "protected_namespace"})
			return
		}
		response.Error(w, http.StatusForbidden, err.Error())
	})
}

func routePattern(r *http.Request) string {
	if rctx := chi.RouteContext(r.Context()); rctx != nil {
		return rctx.RoutePattern()
	}
	return ""
}

// namespaceRuleFor is the rule of a route: its entry, the path's {namespace}, or closed.
func namespaceRuleFor(method, pattern string) scopeRule {
	if rule, ok := namespaceRoutes[method+" "+pattern]; ok {
		return rule
	}
	if strings.Contains(pattern, "{namespace}") {
		return scopePath
	}
	return scopeUnclassified
}

// scopeAsk is what one request asks of a grant limited to namespaces.
type scopeAsk struct {
	namespaces []string // each must be in the grant; "" is a request that names none where one is needed
	spans      string   // the request reaches past any namespace: what it spans, refused outright
}

func (a scopeAsk) refusal(payload auth.TokenPayload, clusterID string, scope []string) (string, string, error) {
	listed := strings.Join(scope, ", ")
	if a.spans != "" {
		return "cluster", clusterID, errors.New("forbidden: " + a.spans + " spans the cluster; your grant on cluster " + clusterID + " is limited to namespaces (" + listed + ")")
	}
	for _, ns := range a.namespaces {
		if payload.AllowedIn(clusterID, ns) {
			continue
		}
		if ns == "" {
			return "namespace", "", errors.New("forbidden: a namespace is required; your grant on cluster " + clusterID + " is limited to namespaces (" + listed + ")")
		}
		return "namespace", ns, errors.New("forbidden: namespace " + ns + " is outside your grant on cluster " + clusterID + " (" + listed + ")")
	}
	return "", "", nil
}

// scopeRule says how a route reaches namespaces. name is what the route table test pins.
type scopeRule struct {
	name string
	ask  func(h *Handler, r *http.Request) scopeAsk
}

func asksNothing(*Handler, *http.Request) scopeAsk { return scopeAsk{} }

func spansCluster(what string) func(*Handler, *http.Request) scopeAsk {
	return func(*Handler, *http.Request) scopeAsk { return scopeAsk{spans: what} }
}

var (
	// A {namespace} in the path. An empty one lists every namespace in the handlers, so it is refused too.
	scopePath = scopeRule{"path", func(_ *Handler, r *http.Request) scopeAsk {
		return scopeAsk{namespaces: []string{chi.URLParam(r, "namespace")}}
	}}
	// As scopePath, but "-" is how the screens name a cluster-scoped custom resource, which has no namespace to check.
	scopePathOrCluster = scopeRule{"path-or-cluster", func(_ *Handler, r *http.Request) scopeAsk {
		ns := chi.URLParam(r, "namespace")
		if ns == "-" {
			return scopeAsk{}
		}
		return scopeAsk{namespaces: []string{ns}}
	}}
	// ?namespace=: each one given must be in the grant; none given is the handler's (it narrows, or asks for one).
	scopeQuery = scopeRule{"query", func(_ *Handler, r *http.Request) scopeAsk {
		return scopeAsk{namespaces: givenValues(r, "namespace")}
	}}
	// ?namespaces=a,b: as scopeQuery, for a list.
	scopeQueryList = scopeRule{"query-list", func(_ *Handler, r *http.Request) scopeAsk {
		var out []string
		for _, v := range r.URL.Query()["namespaces"] {
			out = append(out, splitList(v)...)
		}
		return scopeAsk{namespaces: out}
	}}
	// Takes no namespace; the service reads the grant's namespaces and nothing beside them.
	scopeNarrowed = scopeRule{"narrowed", asksNothing}
	// Takes namespaces its own way or spans the cluster; the handler or service refuses by itself.
	scopeSelfChecked = scopeRule{"self-checked", asksNothing}
	// Objects that live in no namespace, left to the cluster's RBAC as the identity it knows.
	scopeClusterObject = scopeRule{"cluster-object", asksNothing}
	// Facts about the cluster or the feature, no object.
	scopeNoObjects = scopeRule{"no-objects", asksNothing}
	// Reaches other namespaces' objects by what it does; closed to a grant limited to namespaces.
	scopeWholeCluster = scopeRule{"whole-cluster", spansCluster("this action")}
	// The default for a route nobody has classified.
	scopeUnclassified = scopeRule{"unclassified", spansCluster("this route")}

	// The report reads the whole cluster and its sign-offs keep it. Off, the handler answers 404 as for anyone.
	scopeHygiene = scopeRule{"hygiene", func(h *Handler, _ *http.Request) scopeAsk {
		if !h.cfg.HygieneEnabled {
			return scopeAsk{}
		}
		return scopeAsk{spans: "the hygiene report"}
	}}

	// One kind by name: as scopeQuery, and with none given the service narrows, a list of Namespaces to the grant's.
	scopeResourceList = scopeRule{"resource-list", func(_ *Handler, r *http.Request) scopeAsk {
		return scopeAsk{namespaces: givenValues(r, "namespace")}
	}}
	// One object: a namespaced kind must name a namespace of the grant.
	scopeResourceOne = scopeRule{"resource-one", func(h *Handler, r *http.Request) scopeAsk {
		name := queryParam(r, "resource_name", "")
		if name == "" {
			name = queryParam(r, "name", "")
		}
		resourceType := queryParam(r, "resource_type", "")
		if resourceType == "" || name == "" {
			return scopeAsk{namespaces: givenValues(r, "namespace")} // the handler's 400
		}
		given := givenValues(r, "namespace")
		return scopeAsk{namespaces: append(given, h.resourceNamespaces(r, resourceType, queryParam(r, "namespace", ""), name)...)}
	}}
	// A patch of one object from YAML: the object's namespace, and any document naming another.
	scopeResourceApply = scopeRule{"resource-apply", func(h *Handler, r *http.Request) scopeAsk {
		var body applyYAMLBody
		if !peekJSON(r, &body) {
			return scopeAsk{} // the handler's 400
		}
		name := body.Name
		if name == "" {
			name = body.ResourceName
		}
		out := h.resourceNamespaces(r, body.ResourceType, body.Namespace, name)
		return scopeAsk{namespaces: append(out, k8s.YAMLNamespaces(body.YAML)...)}
	}}
	// Every document of a create lands in the grant, or none is created.
	scopeResourceCreate = scopeRule{"resource-create", func(h *Handler, r *http.Request) scopeAsk {
		var body createYAMLBody
		if !peekJSON(r, &body) {
			return scopeAsk{} // the handler's 400
		}
		return scopeAsk{namespaces: h.svc.CreateNamespaces(r.Context(), body.YAML, body.Namespace)}
	}}
	// A new namespace: the grant names it (it may list one that does not exist yet).
	scopeNamespaceCreate = scopeRule{"namespace-create", func(_ *Handler, r *http.Request) scopeAsk {
		var body createNamespaceBody
		if !peekJSON(r, &body) {
			return scopeAsk{} // the handler's 400
		}
		return scopeAsk{namespaces: []string{body.Name}}
	}}
)

// givenValues is every non-empty value of a query parameter, so a repeated one cannot hide behind the first.
func givenValues(r *http.Request, key string) []string {
	var out []string
	for _, v := range r.URL.Query()[key] {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

// resourceNamespaces is the namespace a request for one object reaches: the one it names for a namespaced kind, none
// for a cluster-scoped kind, the object's own name for a Namespace.
func (h *Handler) resourceNamespaces(r *http.Request, resourceType, namespace, name string) []string {
	namespaced, isNamespace := h.svc.ResourceScope(r.Context(), resourceType)
	switch {
	case namespaced:
		return []string{namespace}
	case isNamespace:
		return []string{name}
	}
	return nil
}

// peekJSON decodes the body as the handler will and leaves it to be read again; false when it cannot be decoded.
func peekJSON(r *http.Request, into interface{}) bool {
	if r.Body == nil {
		return false
	}
	raw, err := io.ReadAll(r.Body)
	// A read that failed (too large) fails the same way for the handler.
	r.Body = struct {
		io.Reader
		io.Closer
	}{io.MultiReader(bytes.NewReader(raw), r.Body), r.Body}
	if err != nil {
		return false
	}
	return json.NewDecoder(bytes.NewReader(raw)).Decode(into) == nil
}
