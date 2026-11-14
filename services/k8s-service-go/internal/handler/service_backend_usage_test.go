package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

type fakeBackendUsage struct {
	available bool
	pods      []string
	podsErr   error
	reads     []string
	queries   []string
}

func (f *fakeBackendUsage) PrometheusAvailable(context.Context) bool { return f.available }

func (f *fakeBackendUsage) ServiceBackendPods(_ context.Context, namespace, name string) ([]string, error) {
	f.reads = append(f.reads, namespace+"/"+name)
	return f.pods, f.podsErr
}

func (f *fakeBackendUsage) PrometheusQuery(_ context.Context, q string) ([]k8s.PrometheusQueryResult, error) {
	f.queries = append(f.queries, q)
	if strings.HasPrefix(q, "count(") {
		return []k8s.PrometheusQueryResult{{Value: 2}}, nil
	}
	return []k8s.PrometheusQueryResult{{Value: 1.5}}, nil
}

func getBackendUsage(f *fakeBackendUsage, payload auth.TokenPayload) (*httptest.ResponseRecorder, map[string]interface{}) {
	r := logSearchRequestAs("/api/v1/namespaces/shop/services/web/backend-usage", "self", "shop", payload)
	chi.RouteContext(r.Context()).URLParams.Add("name", "web")
	w := httptest.NewRecorder()
	(&Handler{backendUsageSrc: f}).ServiceBackendUsage(w, r)
	var body map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w, body
}

var clusterReader = auth.TokenPayload{UserID: "u1", Email: "dev@example.com", Perms: auth.PermissionMatrix{"*": {"resource.objects.read"}}}

func TestServiceBackendUsageSumsTheServicesPods(t *testing.T) {
	f := &fakeBackendUsage{available: true, pods: []string{"web-0", "web-1"}}
	w, body := getBackendUsage(f, clusterReader)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if strings.Join(f.reads, ",") != "shop/web" || len(f.queries) != 3 {
		t.Fatalf("read %v, asked %d queries", f.reads, len(f.queries))
	}
	if body["available"] != true || body["pods"] != 2.0 || body["cpu_millicores"] != 1.5 || body["memory_bytes"] != 1.5 || body["pod_count"] != 2.0 || body["queries"] != 3.0 {
		t.Fatalf("body = %v", body)
	}
}

// A grant limited to namespaces is refused the cluster's Prometheus here as on /prometheus/query, before anything is read.
func TestServiceBackendUsageRefusesAGrantLimitedToNamespaces(t *testing.T) {
	scoped := clusterReader
	scoped.Namespaces = map[string][]string{"self": {"shop"}}
	f := &fakeBackendUsage{available: true, pods: []string{"web-0"}}
	w, _ := getBackendUsage(f, scoped)
	if w.Code != http.StatusForbidden || len(f.reads) != 0 || len(f.queries) != 0 {
		t.Fatalf("status %d, read %v, asked %v", w.Code, f.reads, f.queries)
	}
}

func TestServiceBackendUsageWithoutPrometheusOrSlices(t *testing.T) {
	f := &fakeBackendUsage{available: false, pods: []string{"web-0"}}
	w, body := getBackendUsage(f, clusterReader)
	if w.Code != http.StatusOK || body["available"] != false || len(f.reads) != 0 || len(f.queries) != 0 {
		t.Fatalf("no Prometheus: status %d, body %v, read %v", w.Code, body, f.reads)
	}
	f = &fakeBackendUsage{available: true, podsErr: errors.New(`endpointslices.discovery.k8s.io is forbidden: User "u" cannot list resource "endpointslices"`)}
	w, _ = getBackendUsage(f, clusterReader)
	if w.Code < 400 || len(f.queries) != 0 {
		t.Fatalf("slices refused: status %d, asked %v", w.Code, f.queries)
	}
}
