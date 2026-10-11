package handler

import (
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

func TestValidatePrometheusURL(t *testing.T) {
	for _, ok := range []string{"http://prom.monitoring.svc:9090", "https://metrics.example.com/prometheus", " https://m.example.com/select/0/prometheus "} {
		if err := validatePrometheusURL(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "prom.example.com", "ftp://x/y", "http://user:pw@prom:9090", "http://prom:9090/?x=1", "http://prom:9090/#f"} {
		if err := validatePrometheusURL(bad); err == nil {
			t.Errorf("%q: accepted", bad)
		}
	}
}

func TestPrometheusAuthHeader(t *testing.T) {
	if h, err := prometheusAuthHeader(model.PrometheusAuthRequest{Type: "none"}); err != nil || h != "" {
		t.Fatalf("none = %q %v", h, err)
	}
	if h, err := prometheusAuthHeader(model.PrometheusAuthRequest{Type: "bearer", Token: " tok "}); err != nil || h != "Bearer tok" {
		t.Fatalf("bearer = %q %v", h, err)
	}
	h, err := prometheusAuthHeader(model.PrometheusAuthRequest{Type: "basic", Username: "kubeast", Password: "s3cret"})
	if err != nil || !strings.HasPrefix(h, "Basic ") || h == "Basic " {
		t.Fatalf("basic = %q %v", h, err)
	}
	for _, bad := range []model.PrometheusAuthRequest{{Type: "bearer"}, {Type: "basic", Username: "u"}, {Type: "digest", Token: "x"}} {
		if _, err := prometheusAuthHeader(bad); err == nil {
			t.Errorf("%+v: accepted", bad)
		}
	}
}
