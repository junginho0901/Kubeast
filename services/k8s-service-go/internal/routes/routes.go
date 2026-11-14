// Package routes registers HTTP routes onto a chi.Router. Domain
// groupings (pods, workloads, network, …) live in sibling files; this
// file is the single entry point that wires them all up.
//
// main.go is responsible for middleware (JWT, CORS, recovery) and the
// public health endpoints. Once it has constructed the protected
// chi.Group, it hands the group to Register and forgets about routing.
package routes

import (
	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
)

// Register attaches every protected API route to the given router (config.RoleAll). The
// caller (main.go) has already applied the auth middleware to r, so
// each domain file just calls plain r.Get / r.Post / etc.
//
// wsMux is threaded through because the WebSocket multiplexer is part
// of the public API surface but lives in its own package.
func Register(r chi.Router, h *handler.Handler, wsMux *ws.Multiplexer) {
	RegisterRole(r, h, wsMux, config.RoleAll)
}

// RegisterRole attaches the protected routes role serves: the API routes (lists, details, writes, the live lists'
// socket) for "all" and "api", the streams (RegisterStreams) for "all" and "stream". A route of the other role is
// not registered and answers 404.
func RegisterRole(r chi.Router, h *handler.Handler, wsMux *ws.Multiplexer, role config.Role) {
	r = sharingReads(r, h)
	if role.ServesAPI() {
		RegisterCluster(r, h)
		RegisterPods(r, h)
		RegisterWorkloads(r, h)
		RegisterNetwork(r, h)
		RegisterGateway(r, h)
		RegisterStorage(r, h)
		RegisterSecurity(r, h)
		RegisterConfiguration(r, h)
		RegisterHelm(r, h)
		RegisterGPU(r, h)
		RegisterCustomResources(r, h)
		RegisterMetrics(r, h)
		RegisterWS(r, wsMux)
	}
	if role.ServesStreams() {
		RegisterStreams(r, h)
	}
}
