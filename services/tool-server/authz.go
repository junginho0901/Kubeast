// Per-call authorization. ai-service filters the tools it offers a user, but
// tool-server is the component that actually runs kubectl with the cluster's
// credentials, so it re-checks the caller's JWT for the tool AND the cluster
// the call is routed to (deny-by-default, no cross-cluster union).
package main

import (
	"errors"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// defaultClusterID mirrors cluster.Default without importing pkg/cluster (that
// package drags client-go and pgx into this binary).
const defaultClusterID = "default"

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
