// Package protectedns is the rule for the two namespaces Kubeast guards beyond what the cluster's RBAC says, the one
// rule k8s-service and tool-server both apply. The Write group's edit role is bound cluster-wide, so to the cluster
// these namespaces are like any other, yet the install namespace holds the sign-in key and every registered cluster's
// credentials, and the node shell's allows privileged pods.
package protectedns

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail/kube"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// Act is what a request does in the namespace it reaches.
type Act int

const (
	// ActRead reads objects that hold no credential.
	ActRead Act = iota
	// ActSecretRead reads a Secret, or what is kept in one (a Helm release).
	ActSecretRead
	// ActWrite changes something, which includes a pod that mounts the namespace's Secrets.
	ActWrite
	// ActExec runs a process in a container, where the service's credentials are, or talks to a pod or Service straight
	// through the API server, past the gateway in front of it.
	ActExec
	// ActEvict moves a pod off a node and reads nothing: a drain has to pass.
	ActEvict
	// ActLog reads a pod's output, which for a node shell's pod is everything its terminal printed.
	ActLog
)

// Namespaces names the guarded namespaces on one cluster. Install is empty on a cluster Kubeast does not run in, where
// a namespace of that name is an ordinary one; NodeShell holds on every cluster.
type Namespaces struct {
	Install   string `json:"install,omitempty"`
	NodeShell string `json:"node_shell,omitempty"`
}

const nodeShellPermission = "resource.node.shell"

func isGlobalAdmin(p auth.TokenPayload) bool { return auth.MatchAny(p.Perms["*"], "*") }

// ErrRefused marks a refusal, whichever namespace it is about.
var ErrRefused = errors.New("forbidden")

type refusal string

func (r refusal) Error() string        { return string(r) }
func (r refusal) Is(target error) bool { return target == ErrRefused }

// Refusal says why p may not do act in namespace on clusterID, or nil.
func (n Namespaces) Refusal(p auth.TokenPayload, clusterID, namespace string, act Act) error {
	if namespace == "" {
		return nil
	}
	if namespace == n.Install && !isGlobalAdmin(p) && (act == ActSecretRead || act == ActWrite || act == ActExec) {
		return refusal("forbidden: namespace " + namespace + " holds Kubeast's own credentials on this cluster: only a global admin may read its Secrets, change anything in it or run commands in its pods")
	}
	if namespace == n.NodeShell && (act == ActWrite || act == ActExec || act == ActLog) && !p.HasPermissionForCluster(nodeShellPermission, clusterID) {
		return refusal("forbidden: namespace " + namespace + " runs privileged node shells: changing anything in it, running commands in its pods or reading their logs requires " + nodeShellPermission + " on cluster " + clusterID)
	}
	return nil
}

// ActOf reads a Kubernetes request as an Act, verb and resource as the API server names them.
func ActOf(group, verb, resource, subresource string) Act {
	switch subresource {
	case "exec", "attach", "portforward", "proxy":
		return ActExec
	case "eviction":
		return ActEvict
	case "log":
		return ActLog
	}
	switch verb {
	case "get", "list", "watch":
		if group == "" && resource == "secrets" && subresource == "" {
			return ActSecretRead
		}
		return ActRead
	}
	return ActWrite
}

// Check holds one request to the cluster to the rule, as the API server would read it. A list of every namespace's
// Secrets is not refused: it is changed in place to leave the install namespace out, so the API server pages it right.
func (n Namespaces) Check(p auth.TokenPayload, clusterID string, req *http.Request) error {
	if n == (Namespaces{}) || isGlobalAdmin(p) {
		return nil
	}
	info := kube.Describe(req)
	if info.Resource == "" {
		return nil
	}
	act := ActOf(info.Group, info.Verb, info.Resource, info.Subresource)
	if info.Namespace != "" {
		return n.Refusal(p, clusterID, info.Namespace, act)
	}
	if act == ActSecretRead && n.Install != "" {
		query := req.URL.Query()
		selector := query.Get("fieldSelector")
		if selector != "" {
			selector += ","
		}
		query.Set("fieldSelector", selector+"metadata.namespace!="+n.Install)
		req.URL.RawQuery = query.Encode()
	}
	return nil
}

type guard struct {
	base      http.RoundTripper
	rules     Namespaces
	clusterID string
	pinned    *auth.TokenPayload
}

// RoundTripper wraps base for one cluster: a request whose context carries the signed-in user is held to the rule. A
// request with none is Kubeast's own (the informers) and passes.
func RoundTripper(base http.RoundTripper, rules Namespaces, clusterID string) http.RoundTripper {
	return &guard{base: base, rules: rules, clusterID: clusterID}
}

// Pinned is RoundTripper for a config that acts for one user whatever the request's context says, as the Helm SDK and
// the exec stream do with their own contexts.
func Pinned(base http.RoundTripper, rules Namespaces, clusterID string, p auth.TokenPayload) http.RoundTripper {
	return &guard{base: base, rules: rules, clusterID: clusterID, pinned: &p}
}

func (g *guard) RoundTrip(req *http.Request) (*http.Response, error) {
	p, ok := auth.FromContext(req.Context())
	if !ok && g.pinned != nil {
		p, ok = *g.pinned, true
	}
	if !ok {
		return g.base.RoundTrip(req)
	}
	r2 := req.Clone(req.Context())
	if err := g.rules.Check(p, g.clusterID, r2); err != nil {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		body := statusBody(err)
		return &http.Response{
			Status: http.StatusText(http.StatusForbidden), StatusCode: http.StatusForbidden,
			Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
			Header:        http.Header{"Content-Type": {"application/json"}},
			Body:          io.NopCloser(bytes.NewReader(body)),
			ContentLength: int64(len(body)),
			Request:       req,
		}, nil
	}
	return g.base.RoundTrip(r2)
}

// WriteForbidden answers a refusal as the API server would, for a client that talks to a proxy.
func WriteForbidden(w http.ResponseWriter, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write(statusBody(err))
}

// statusBody is a Kubernetes Status, which client-go turns into the same Forbidden error as the cluster's own refusal.
func statusBody(err error) []byte {
	body, _ := json.Marshal(map[string]interface{}{
		"kind": "Status", "apiVersion": "v1", "metadata": map[string]string{},
		"status": "Failure", "reason": "Forbidden", "code": http.StatusForbidden, "message": err.Error(),
	})
	return body
}
