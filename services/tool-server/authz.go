// Per-call authorization. ai-service filters the tools it offers a user, but
// tool-server is the component that actually runs kubectl with the cluster's
// credentials, so it re-checks the caller's JWT for the tool AND the cluster
// the call is routed to (deny-by-default, no cross-cluster union).
package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// defaultClusterID mirrors cluster.Default without importing pkg/cluster (that
// package drags client-go and pgx into this binary).
const defaultClusterID = "default"

// approvalHeader carries the id of the user's approval for a write tool.
// ai-service sets it only on the approve path (H2); the streaming path never
// executes write tools, so a write call without it is refused outright.
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
func approvalGate(headers http.Header, tool string) (int, error) {
	if !writeApprovalRequired || !requiresApproval(tool) {
		return 0, nil
	}
	if strings.TrimSpace(headers.Get(approvalHeader)) == "" {
		return http.StatusForbidden, fmt.Errorf("write tool %q requires an approved request (%s)", tool, approvalHeader)
	}
	return 0, nil
}

type tokenValidator interface {
	Validate(token string) (auth.TokenPayload, error)
}

var (
	errNoToken   = errors.New("bearer token required")
	errForbidden = errors.New("forbidden")
)

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
