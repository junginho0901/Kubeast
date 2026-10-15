// Per-call authorization. ai-service filters the tools it offers a user, but
// tool-server is the component that actually runs kubectl with the cluster's
// credentials, so it re-checks the caller's JWT for the tool AND the cluster
// the call is routed to (deny-by-default, no cross-cluster union).
package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// defaultClusterID mirrors cluster.Default without importing pkg/cluster (that
// package drags client-go and pgx into this binary).
const defaultClusterID = "default"

// approvalHeader carries the id of the user's approval for a write tool.
// ai-service sets it on the chat's approve path (H2) and, per call, on the MCP
// path (the agent acts under the user's own key and the MCP client is the
// human in the loop); the streaming path never executes write tools, so a
// write call without it is refused outright.
const approvalHeader = "X-Kubeast-Approval-Id"

// writeTools change cluster state (same set as ai-service WRITE_TOOL_NAMES).
var writeTools = map[string]struct{}{
	"k8s_apply_manifest": {}, "k8s_create_resource": {}, "k8s_delete_resource": {}, "k8s_patch_resource": {},
	"k8s_annotate_resource": {}, "k8s_remove_annotation": {}, "k8s_label_resource": {}, "k8s_remove_label": {},
	"k8s_scale": {}, "k8s_rollout": {}, "k8s_execute_command": {},
}

func requiresApproval(tool string) bool {
	_, ok := writeTools[tool]
	return ok
}

// approvalGate rejects a write tool call that does not carry an approval id.
func approvalGate(headers http.Header, tool, clusterID string, payload auth.TokenPayload, args map[string]interface{}) (int, error) {
	if !writeApprovalRequired || !requiresApproval(tool) {
		return 0, nil
	}
	id := strings.TrimSpace(headers.Get(approvalHeader))
	token := strings.TrimSpace(headers.Get(approvalTokenHeader))
	if id == "" || token == "" {
		return http.StatusForbidden, fmt.Errorf("write tool %q requires an approved request (%s, %s)", tool, approvalHeader, approvalTokenHeader)
	}
	if clusterID == "" {
		clusterID = defaultClusterID
	}
	// The token binds the approval to the user, cluster, tool and arguments
	// of this very call; the id alone proves nothing.
	if err := verifyApprovalToken(approvalSecret, token, id, payload.UserID, clusterID, tool, args, time.Now()); err != nil {
		if approvalSecret == "" {
			return http.StatusServiceUnavailable, err
		}
		return http.StatusForbidden, err
	}
	return 0, nil
}

// approvalSecret is shared with ai-service (AI_APPROVAL_SECRET). Without it a
// write tool cannot be verified and is refused rather than waved through.
var approvalSecret = strings.TrimSpace(os.Getenv(approvalSecretEnv))

type tokenValidator interface {
	Validate(token string) (auth.TokenPayload, error)
}

var (
	errNoToken   = errors.New("bearer token required")
	errForbidden = errors.New("forbidden")
)

// clusterWideTools take no namespace: refused outright for a caller whose
// grant on the cluster is limited to namespaces (the token's "ns" claim).
var clusterWideTools = map[string]struct{}{
	"k8s_get_available_api_resources": {}, "k8s_get_cluster_configuration": {},
	"k8s_apply_manifest": {}, "k8s_create_resource": {},
	"get_cluster_overview": {}, "get_node_metrics": {},
	// PromQL is not bounded by a namespace; the hygiene report covers the cluster;
	// a manifest preview names its own object.
	"prometheus_query": {}, "hygiene": {}, "k8s_diff": {},
}

// namespaceAwareTools apply a namespace-scoped grant themselves — the handler
// reads the token's "ns" claim and searches only those namespaces — so they
// pass the gate without naming one.
var namespaceAwareTools = map[string]struct{}{"k8s_find_resource": {}, "issues": {}, "cost": {}}

// namespaceFreeTools return API schema, not object data, so a scoped grant
// may call them without a namespace.
var namespaceFreeTools = map[string]struct{}{"k8s_explain": {}}

var errNamespaceScope = errors.New("namespace scope")

// namespaceGate applies a namespace-scoped grant to a tool call: the call
// must name one of the granted namespaces, and a tool that spans the cluster
// is refused. An unscoped caller passes untouched.
func namespaceGate(payload auth.TokenPayload, clusterID, tool string, args map[string]interface{}) error {
	if clusterID == "" {
		clusterID = defaultClusterID
	}
	scope := payload.Namespaces[clusterID]
	if len(scope) == 0 {
		return nil
	}
	if _, wide := clusterWideTools[tool]; wide {
		return fmt.Errorf("%w: %s spans the cluster; your grant on %s is limited to namespaces %s", errNamespaceScope, tool, clusterID, strings.Join(scope, ", "))
	}
	if _, free := namespaceFreeTools[tool]; free {
		return nil
	}
	ns, _ := args["namespace"].(string)
	ns = strings.TrimSpace(ns)
	if _, aware := namespaceAwareTools[tool]; aware && ns == "" {
		return nil
	}
	if ns == "" {
		return fmt.Errorf("%w: namespace is required; your grant on %s is limited to namespaces %s", errNamespaceScope, clusterID, strings.Join(scope, ", "))
	}
	if !payload.AllowedIn(clusterID, ns) {
		return fmt.Errorf("%w: namespace %q is outside your grant on %s (%s)", errNamespaceScope, ns, clusterID, strings.Join(scope, ", "))
	}
	return nil
}

// authorizeToolCall returns the validated caller, or an HTTP status + error:
// 401 when the token is missing/invalid, 403 when ai.tool.<tool> is not
// granted in clusterID ("" = the default cluster).
func authorizeToolCall(v tokenValidator, headers http.Header, tool, clusterID string) (auth.TokenPayload, int, error) {
	token := extractBearerToken(headers)
	if token == "" {
		return auth.TokenPayload{}, http.StatusUnauthorized, errNoToken
	}
	payload, err := v.Validate(token)
	if err != nil {
		return auth.TokenPayload{}, http.StatusUnauthorized, err
	}
	if clusterID == "" {
		clusterID = defaultClusterID
	}
	if !payload.HasPermissionForCluster("ai.tool."+tool, clusterID) {
		return payload, http.StatusForbidden, errForbidden
	}
	return payload, 0, nil
}
