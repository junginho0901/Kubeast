package kube

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

func TestDescribe(t *testing.T) {
	cases := []struct {
		method, path string
		want         accesstrail.Request
	}{
		{"GET", "/api/v1/namespaces/shop/pods", accesstrail.Request{Source: "api", Verb: "list", Resource: "pods", Namespace: "shop"}},
		{"GET", "/api/v1/namespaces/shop/pods?watch=true", accesstrail.Request{Source: "api", Verb: "watch", Resource: "pods", Namespace: "shop"}},
		{"GET", "/apis/apps/v1/namespaces/shop/deployments/checkout", accesstrail.Request{Source: "api", Verb: "get", Group: "apps", Resource: "deployments", Namespace: "shop", Name: "checkout"}},
		{"PATCH", "/apis/apps/v1/namespaces/shop/deployments/api/scale", accesstrail.Request{Source: "api", Verb: "patch", Group: "apps", Resource: "deployments", Subresource: "scale", Namespace: "shop", Name: "api"}},
		{"GET", "/api/v1/namespaces/shop/pods/web-1/log", accesstrail.Request{Source: "api", Verb: "get", Resource: "pods", Subresource: "log", Namespace: "shop", Name: "web-1"}},
		{"POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", accesstrail.Request{Source: "api", Verb: "create", Group: "authorization.k8s.io", Resource: "selfsubjectaccessreviews"}},
		{"GET", "/api/v1/nodes", accesstrail.Request{Source: "api", Verb: "list", Resource: "nodes"}},
		// a server behind a proxy path (Rancher-style): read from /api on
		{"GET", "/k8s/clusters/c-1/api/v1/namespaces/shop/pods", accesstrail.Request{Source: "api", Verb: "list", Resource: "pods", Namespace: "shop"}},
		{"GET", "/version", accesstrail.Request{Source: "api", Verb: "get", Path: "/version"}},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, "https://cluster.example"+c.path, nil)
		if got := Describe(req); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %s = %+v, want %+v", c.method, c.path, got, c.want)
		}
	}
}

// With a Recorder in the context each request goes out with its own Audit-ID
// and is listed with the answer's status and whether the server echoed the ID;
// without one nothing is added.
func TestRoundTripper(t *testing.T) {
	var sent []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(accesstrail.HeaderAuditID)
		sent = append(sent, id)
		if !strings.Contains(r.URL.Path, "/exec") { // exec-like answers come back without it
			w.Header().Set("Audit-Id", id)
		}
		if strings.HasSuffix(r.URL.Path, "/secrets") {
			w.WriteHeader(http.StatusForbidden)
		}
	}))
	defer srv.Close()
	client := &http.Client{Transport: RoundTripper(http.DefaultTransport)}

	get := func(ctx context.Context, path string) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+path, nil)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	get(context.Background(), "/api/v1/pods")
	if sent[0] != "" {
		t.Fatalf("no recorder: Audit-ID %q sent", sent[0])
	}

	rec := &accesstrail.Recorder{}
	ctx := accesstrail.NewContext(context.Background(), rec)
	get(ctx, "/api/v1/namespaces/shop/pods")
	get(ctx, "/api/v1/namespaces/shop/secrets")
	get(ctx, "/api/v1/namespaces/shop/pods/web-1/exec")
	trail := rec.Snapshot()
	if trail.Total != 3 || len(trail.Requests) != 3 {
		t.Fatalf("trail %+v", trail)
	}
	for i, r := range trail.Requests {
		if !strings.HasPrefix(r.AuditID, "kubeast-") || len(r.AuditID) != len("kubeast-")+32 || r.AuditID != sent[i+1] {
			t.Fatalf("request %d: audit id %q, sent %q", i, r.AuditID, sent[i+1])
		}
	}
	if trail.Requests[0].AuditID == trail.Requests[1].AuditID {
		t.Fatal("two requests share an Audit-ID")
	}
	got := []struct {
		status int
		echoed bool
	}{{trail.Requests[0].Status, trail.Requests[0].Echoed}, {trail.Requests[1].Status, trail.Requests[1].Echoed}, {trail.Requests[2].Status, trail.Requests[2].Echoed}}
	want := []struct {
		status int
		echoed bool
	}{{200, true}, {403, true}, {200, false}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("status/echo %+v, want %+v", got, want)
	}
	if r := trail.Requests[1]; r.Verb != "list" || r.Resource != "secrets" || r.Namespace != "shop" {
		t.Fatalf("second request read as %+v", r)
	}
}

func TestRecorderCapAndHeader(t *testing.T) {
	rec := &accesstrail.Recorder{}
	for i := 0; i < accesstrail.MaxRequests+5; i++ {
		rec.Add(accesstrail.Request{Source: "api", Verb: "get"})
	}
	accesstrail.Cached(accesstrail.NewContext(context.Background(), rec), "overview")
	other := &accesstrail.Recorder{}
	other.Merge(rec.Snapshot())
	trail := other.Snapshot()
	if trail.Total != accesstrail.MaxRequests+6 || len(trail.Requests) != accesstrail.MaxRequests {
		t.Fatalf("total %d kept %d", trail.Total, len(trail.Requests))
	}
	back, ok := accesstrail.ParseHeader(trail.Header())
	if !ok || !reflect.DeepEqual(back, trail) {
		t.Fatalf("header round trip %+v %v", back, ok)
	}
	if _, ok := accesstrail.ParseHeader("%%"); ok {
		t.Fatal("garbage parsed")
	}
	accesstrail.Cached(context.Background(), "nothing records this") // no recorder: no panic
}
