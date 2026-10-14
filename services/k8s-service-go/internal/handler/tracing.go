package handler

import "github.com/junginho0901/kubeast/services/k8s-service-go/internal/tracing"

// SetTracing turns on trace links (chart features.tracing).
func (h *Handler) SetTracing(c tracing.Config) { h.tracing = c }

// tracingFeature is the /cluster/features entry: the URL templates the screen
// fills with a trace ID or a Pod's service.
func (h *Handler) tracingFeature() map[string]interface{} {
	if !h.tracing.Enabled {
		return map[string]interface{}{"enabled": false}
	}
	return map[string]interface{}{
		"enabled":   true,
		"traceUrl":  h.tracing.TraceURL,
		"searchUrl": h.tracing.SearchURL,
	}
}
