package handler

import (
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/tracing"
)

func TestTracingFeature(t *testing.T) {
	if got := (&Handler{}).tracingFeature(); got["enabled"] != false || len(got) != 1 {
		t.Fatalf("off: %v", got)
	}
	h := &Handler{}
	h.SetTracing(tracing.Config{Enabled: true, TraceURL: "https://jaeger.example.com/trace/{{traceId}}"})
	got := h.tracingFeature()
	if got["enabled"] != true || got["traceUrl"] != "https://jaeger.example.com/trace/{{traceId}}" || got["searchUrl"] != "" {
		t.Fatalf("on: %v", got)
	}
}
