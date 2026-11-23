package proxypath

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

func TestPrefixIsTheServiceProxyPartOfAPath(t *testing.T) {
	for p, want := range map[string]string{
		"/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query":        "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy",
		"/api/v1/namespaces/monitoring/services/prometheus:9090/proxy":                     "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy",
		"/k8s/clusters/c-1/api/v1/namespaces/ns/services/https:relay:443/proxy/observer":   "/k8s/clusters/c-1/api/v1/namespaces/ns/services/https:relay:443/proxy",
		"/api/v1/namespaces/vm/services/vmselect:8481/proxy/select/0/prometheus/-/healthy": "/api/v1/namespaces/vm/services/vmselect:8481/proxy",
		"/api/v1/namespaces/ns/services/svc:80/proxyx/a":                                   "",
		"/api/v1/namespaces/ns/pods/p/proxy/a":                                             "",
		"/api/v1/namespaces//services/svc/proxy":                                           "",
		"/api/v1/namespaces/ns/secrets":                                                    "",
		"/version":                                                                         "",
	} {
		got, ok := Prefix(p)
		if got != want || ok != (want != "") {
			t.Errorf("%s: %q %v, want %q", p, got, ok, want)
		}
	}
}

// follow runs Follow on a redirect to loc from first, after hops redirects, as net/http's client calls it.
func follow(t *testing.T, first, loc string, hops int) error {
	t.Helper()
	f, err := url.Parse(first)
	if err != nil {
		t.Fatal(err)
	}
	u, err := f.Parse(loc)
	if err != nil {
		t.Fatal(err)
	}
	via := []*http.Request{{URL: f}}
	for len(via) < hops {
		via = append(via, &http.Request{URL: f})
	}
	return Follow(&http.Request{URL: u}, via)
}

// A Service read through the API server follows a redirect only on the same API server and under the same Service's
// proxy path: the client sends the cluster's credentials with every request, and the API server passes on a Location
// naming another host as the Service wrote it.
func TestARedirectIsFollowedOnlyUnderTheServicesProxyPath(t *testing.T) {
	const first = "https://api.example:6443/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query?query=up"
	for loc, want := range map[string]string{
		"/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/prometheus/api/v1/query": "",
		"https://API.example:6443/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy": "",
		"https://other.example/api/v1/query":                                                             "another server",
		"//other.example/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/x":           "another server",
		"http://api.example:6443/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/x":   "another server",
		"https://api.example:443/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/x":   "another server",
		"/k8s/c1/api/v1/namespaces/kube-system/secrets":                                                  "leaves the Service's path",
		"/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/../../grafana:3000/proxy/x": "leaves the Service's path",
		"/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxyx":                           "leaves the Service's path",
		"/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/x":                                 "leaves the Service's path",
		"/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/%2e%2e/%2E%2E/x":            `"." or ".."`,
		"/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/a/..%2f..%2fx":              `"." or ".."`,
		"/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/%2e/x":                      `"." or ".."`,
	} {
		err := follow(t, first, loc, 1)
		switch {
		case want == "" && err != nil:
			t.Errorf("%s: %v, want followed", loc, err)
		case want != "" && (!errors.Is(err, ErrRedirect) || !strings.Contains(err.Error(), want)):
			t.Errorf("%s: %v, want not followed: %s", loc, err, want)
		}
	}
	inside := "/k8s/c1/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/next"
	if err := follow(t, first, inside, MaxRedirects-1); err != nil {
		t.Errorf("redirect %d inside: %v", MaxRedirects, err)
	}
	if err := follow(t, first, inside, MaxRedirects); !errors.Is(err, ErrRedirect) || !strings.Contains(err.Error(), "after 10 redirects") {
		t.Errorf("redirect %d: %v", MaxRedirects+1, err)
	}
	if err := follow(t, "https://api.example:6443/api/v1/namespaces/ns/pods", "/api/v1/namespaces/ns/pods?x=1", 1); !errors.Is(err, ErrRedirect) {
		t.Errorf("a first request outside a Service proxy: %v", err)
	}
}

func TestFollowNoneFollowsNone(t *testing.T) {
	u, _ := url.Parse("https://relay.example:4245/observer.Observer/GetFlows")
	if err := FollowNone(&http.Request{URL: u}, []*http.Request{{URL: u}}); !errors.Is(err, ErrRedirect) {
		t.Fatalf("same address: %v", err)
	}
}

// What net/http returns around the rule's error names the Location; NotFollowed gives the rule's words without it.
func TestNotFollowedLeavesTheLocationOut(t *testing.T) {
	wrapped := &url.Error{Op: "Get", URL: "https://other.example/x?k=v", Err: &redirectError{"it points to another server or scheme than the cluster's API server"}}
	nf := NotFollowed(fmt.Errorf("read: %w", wrapped))
	if nf == nil || !errors.Is(nf, ErrRedirect) || strings.Contains(nf.Error(), "other.example") {
		t.Fatalf("%v", nf)
	}
	if NotFollowed(errors.New("connection refused")) != nil || NotFollowed(nil) != nil {
		t.Fatal("no redirect, nothing not followed")
	}
}

// A Kubernetes Status is the API server's own answer; the store's bodies, JSON or text, are the store's.
func TestAStatusBodyIsTheAPIServersOwnAnswer(t *testing.T) {
	long := strings.Repeat("ä", 400)
	for name, c := range map[string]struct {
		code    int
		body    string
		cluster bool
		check   func(*apierrors.StatusError) bool
	}{
		"refusal": {403, `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"services \"prometheus:9090\" is forbidden","reason":"Forbidden","code":403}`, true,
			func(e *apierrors.StatusError) bool {
				return apierrors.IsForbidden(e) && strings.Contains(e.Error(), "is forbidden")
			}},
		"no endpoints": {503, `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"no endpoints available for service \"prometheus:9090\"","reason":"ServiceUnavailable","code":503}`, true,
			func(e *apierrors.StatusError) bool { return apierrors.IsServiceUnavailable(e) }},
		"no code in the body": {404, `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"services \"x\" not found"}`, true,
			func(e *apierrors.StatusError) bool { return e.ErrStatus.Code == 404 && apierrors.IsNotFound(e) }},
		"a long message": {500, `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"` + long + `"}`, true,
			func(e *apierrors.StatusError) bool { return len([]rune(e.ErrStatus.Message)) == 300 }},
		"Prometheus's error":     {400, `{"status":"error","errorType":"bad_data","error":"parse error"}`, false, nil},
		"an auth proxy's text":   {401, "Unauthorized\n", false, nil},
		"kube-rbac-proxy's text": {403, "Forbidden (user=system:serviceaccount:x:y, verb=get, resource=, subresource=)", false, nil},
		"another kind":           {404, `{"kind":"Pod","apiVersion":"v1"}`, false, nil},
		"Status of another API":  {404, `{"kind":"Status","apiVersion":"meta.example/v2"}`, false, nil},
		"empty":                  {502, "", false, nil},
		"too long to be one":     {500, `{"kind":"Status","apiVersion":"v1","message":"` + strings.Repeat("x", 70<<10) + `"}`, false, nil},
	} {
		got, ok := APIServerAnswer(c.code, []byte(c.body))
		if ok != c.cluster || (ok && !c.check(got)) {
			t.Errorf("%s: %v %v", name, got, ok)
		}
	}
}
