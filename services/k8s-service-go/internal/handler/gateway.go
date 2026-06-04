package handler

import "strings"

// Gateway API handler set. Per-kind HTTP handlers live in sibling files in
// this package:
//   - gateway_class.go : Gateways + GatewayClasses
//   - gateway_route.go : HTTPRoutes + GRPCRoutes
//   - gateway_grant.go : ReferenceGrants
//   - gateway_policy.go: BackendTLSPolicies + BackendTrafficPolicies
//
// This file keeps the shared "Gateway API not installed" detector used by
// every handler above to gracefully degrade to an empty response.

// isGatewayAPINotAvailable checks if the error indicates Gateway API CRDs are not installed.
func isGatewayAPINotAvailable(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "could not find the requested resource") ||
		strings.Contains(msg, "not found") ||
		strings.Contains(msg, "Gateway API not available")
}
