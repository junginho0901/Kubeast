package k8s

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// otherHost is a server that is not the cluster's API server. It counts each request that reaches it and notes
// whether it carried the cluster's token or the person's identity headers.
type otherHost struct {
	mu   sync.Mutex
	seen []string
	srv  *httptest.Server
}

func newOtherHost(t *testing.T) *otherHost {
	t.Helper()
	o := &otherHost{}
	o.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		o.mu.Lock()
		o.seen = append(o.seen, r.Method+" "+r.URL.Path+" cluster token: "+strconv.FormatBool(r.Header.Get("Authorization") == "Bearer fake-cluster-token")+
			", person headers: "+strconv.FormatBool(r.Header.Get("Impersonate-User") != ""))
		o.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	t.Cleanup(o.srv.Close)
	return o
}

func (o *otherHost) requests() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.seen...)
}

// answer is what the API server stand-in writes for a path: a redirect to location, or code with body.
type answer struct {
	code        int
	contentType string
	body        string
	location    string
}

func apiStatus(code int, reason, message string) answer {
	return answer{code: code, contentType: "application/json",
		body: `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"` + message + `","reason":"` + reason + `","code":` + strconv.Itoa(code) + `}`}
}

func storeText(code int, body string) answer {
	return answer{code: code, contentType: "text/plain; charset=utf-8", body: body}
}

const (
	promProxy = "/api/v1/namespaces/monitoring/services/prometheus:9/proxy"
	costProxy = "/api/v1/namespaces/opencost/services/opencost:9003/proxy"
)

// proxyAPIServer is a cluster's API server that answers the paths of answers and a 404 Status on any other, whose
// paths it lists in elsewhere; its client sends a cluster token and the person's identity headers.
func proxyAPIServer(t *testing.T, answers map[string]answer) (*Service, func() []string) {
	return proxyAPIServerAt(t, "", answers)
}

// proxyAPIServerAt is proxyAPIServer whose server URL ends with serverPath (a proxy in front of the API server).
func proxyAPIServerAt(t *testing.T, serverPath string, answers map[string]answer) (*Service, func() []string) {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "")
	t.Setenv("PROMETHEUS_CLUSTER_LABEL", "")
	var mu sync.Mutex
	var elsewhere []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a, ok := answers[r.URL.Path]
		if !ok {
			mu.Lock()
			elsewhere = append(elsewhere, r.URL.Path)
			mu.Unlock()
			a = apiStatus(http.StatusNotFound, "NotFound", "the server could not find the requested resource")
		}
		if a.location != "" {
			// written as the store wrote it: http.Redirect would clean the path; with a body, as http.Redirect writes one
			w.Header().Set("Location", a.location)
			w.WriteHeader(http.StatusFound)
			_, _ = w.Write([]byte("<a href=\"x\">Found</a>.\n"))
			return
		}
		w.Header().Set("Content-Type", a.contentType)
		w.WriteHeader(a.code)
		_, _ = w.Write([]byte(a.body))
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL + serverPath, BearerToken: "fake-cluster-token",
		Impersonate: rest.ImpersonationConfig{UserName: "dev@example.com", Groups: []string{"kubeast:viewer"}}})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{promQ: newPromQueryCache(0)}
	s.defaultBundle.Store(&clientBundle{clientset: cs, prom: &promCache{}, cost: &costCache{},
		promSvc: &promServiceInfo{Namespace: "monitoring", Name: "prometheus", Port: 9}})
	return s, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), elsewhere...)
	}
}

const promAnswer = `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"job":"kubelet"},"value":[1,"1"]}]}}`

// A read of the Prometheus Service through the API server follows a redirect only on that API server and under the
// Service's proxy path: client-go sends the cluster's token and the person's headers with every request it makes, a
// redirect's too, and the API server passes on a Location naming another host as the store wrote it. A redirect the
// read does not follow is the store not answering (502), in words that leave the Location out.
func TestPrometheusProxyFollowsARedirectOnlyInsideItsServicePath(t *testing.T) {
	other := newOtherHost(t)
	for name, c := range map[string]struct {
		location string
		followed bool
		why      string
	}{
		"another host":                    {other.srv.URL + "/api/v1/query", false, "another server"},
		"another host, the same path":     {other.srv.URL + promProxy + "/api/v1/query", false, "another server"},
		"outside the Service":             {"/api/v1/namespaces/kube-system/secrets", false, "leaves the Service's path"},
		"another Service by dot segments": {promProxy + "/%2e%2e/%2e%2e/grafana:3000/proxy/api/v1/query", false, `"." or ".."`},
		"inside the Service":              {promProxy + "/moved/api/v1/query", true, ""},
	} {
		s, elsewhere := proxyAPIServer(t, map[string]answer{
			promProxy + "/api/v1/query":       {location: c.location},
			promProxy + "/moved/api/v1/query": {code: http.StatusOK, contentType: "application/json", body: promAnswer},
		})
		got, err := s.PrometheusQuery(context.Background(), "up")
		if c.followed {
			if err != nil || len(got) != 1 {
				t.Errorf("%s: %v %v, want the answer at the Location", name, got, err)
			}
			continue
		}
		if !errors.Is(err, ErrPrometheusUpstream) || !strings.Contains(err.Error(), "redirect not followed: ") || !strings.Contains(err.Error(), c.why) {
			t.Errorf("%s: %v, want the store not answering: %s", name, err, c.why)
		}
		if err != nil && strings.Contains(err.Error(), other.srv.URL) {
			t.Errorf("%s: %v names the Location", name, err)
		}
		if seen := elsewhere(); len(seen) != 0 {
			t.Errorf("%s: the API server was asked %v", name, seen)
		}
	}
	if seen := other.requests(); len(seen) != 0 {
		t.Fatalf("another host was sent %d requests: %v", len(seen), seen)
	}
}

// A server URL with a path (a proxy in front of the API server) keeps it: the read goes under it, as before, and so
// must a redirect the read follows.
func TestProxyReadsKeepTheServerURLsPath(t *testing.T) {
	const at = "/k8s/clusters/c-1"
	for name, c := range map[string]struct {
		location string
		followed bool
	}{
		"under the server path":   {at + promProxy + "/moved/api/v1/query", true},
		"without the server path": {promProxy + "/moved/api/v1/query", false},
	} {
		s, elsewhere := proxyAPIServerAt(t, at, map[string]answer{
			at + promProxy + "/api/v1/query":       {location: c.location},
			at + promProxy + "/moved/api/v1/query": {code: http.StatusOK, contentType: "application/json", body: promAnswer},
		})
		got, err := s.PrometheusQuery(context.Background(), "up")
		if c.followed != (err == nil && len(got) == 1) || len(elsewhere()) != 0 {
			t.Errorf("%s: %v %v, asked elsewhere %v", name, got, err, elsewhere())
		}
	}
}

// The store's own 401 or 403 (an authenticating proxy in front of it) is the store not answering, a 502: before, it
// read as the person's sign-in failing (401) or the cluster refusing them (403). The API server's own answers are told
// apart by their body, a Kubernetes Status: its 403 stays a refusal, a missing Service is no "not served" of the store.
func TestPrometheusProxyTellsTheAPIServersAnswersFromTheStores(t *testing.T) {
	ctx := context.Background()
	query := func(a answer) error {
		s, _ := proxyAPIServer(t, map[string]answer{promProxy + "/api/v1/query": a})
		_, err := s.PrometheusQuery(ctx, "up")
		return err
	}
	if err := query(storeText(http.StatusUnauthorized, "Unauthorized")); !errors.Is(err, ErrPrometheusUpstream) || apierrors.IsUnauthorized(err) ||
		!strings.Contains(err.Error(), "status 401") || !strings.Contains(err.Error(), "itself: Unauthorized") {
		t.Errorf("store 401: %v", err)
	}
	if err := query(storeText(http.StatusForbidden, "Forbidden (user=system:serviceaccount:monitoring:x, verb=get)")); !errors.Is(err, ErrPrometheusUpstream) || apierrors.IsForbidden(err) {
		t.Errorf("store 403: %v", err)
	}
	if err := query(apiStatus(http.StatusForbidden, "Forbidden", `services \"prometheus:9\" is forbidden`)); !apierrors.IsForbidden(err) || errors.Is(err, ErrPrometheusUpstream) {
		t.Errorf("API server 403: %v", err)
	}
	if err := query(apiStatus(http.StatusNotFound, "NotFound", `services \"prometheus\" not found`)); !errors.Is(err, ErrPrometheusUpstream) || apierrors.IsNotFound(err) ||
		!strings.Contains(err.Error(), "API server answered for the Prometheus Service monitoring/prometheus:9") {
		t.Errorf("API server 404: %v", err)
	}
	if err := query(answer{code: http.StatusBadRequest, contentType: "application/json", body: `{"status":"error","errorType":"bad_data","error":"parse error"}`}); !apierrors.IsBadRequest(err) || errors.Is(err, ErrPrometheusUpstream) {
		t.Errorf("store 400 stays the caller's request: %v", err)
	}

	data := func(a answer) error {
		s, _ := proxyAPIServer(t, map[string]answer{promProxy + "/api/v1/rules": a})
		_, err := s.promGetData(ctx, s.getPromSource(ctx), "/api/v1/rules")
		return err
	}
	if err := data(storeText(http.StatusNotFound, "404 page not found")); !errors.Is(err, ErrPrometheusNotServed) {
		t.Errorf("store 404: %v", err)
	}
	if err := data(apiStatus(http.StatusNotFound, "NotFound", `services \"prometheus\" not found`)); errors.Is(err, ErrPrometheusNotServed) || !errors.Is(err, ErrPrometheusUpstream) {
		t.Errorf("API server 404 (no Service): %v", err)
	}
	if err := data(apiStatus(http.StatusServiceUnavailable, "ServiceUnavailable", `no endpoints available for service \"prometheus:9\"`)); !errors.Is(err, ErrPrometheusUpstream) || !strings.Contains(err.Error(), "no endpoints available") {
		t.Errorf("API server 503: %v", err)
	}
	if err := data(storeText(http.StatusUnauthorized, "Unauthorized")); !errors.Is(err, ErrPrometheusUpstream) || apierrors.IsUnauthorized(err) {
		t.Errorf("store 401: %v", err)
	}
	if err := data(apiStatus(http.StatusForbidden, "Forbidden", "forbidden")); !apierrors.IsForbidden(err) || errors.Is(err, ErrPrometheusUpstream) {
		t.Errorf("API server 403: %v", err)
	}

	info := &promServiceInfo{Namespace: "monitoring", Name: "prometheus", Port: 9}
	for name, c := range map[string]struct {
		a     answer
		found bool
	}{
		"healthy":          {storeText(http.StatusOK, "Prometheus Server is Healthy.\n"), true},
		"API server 403":   {apiStatus(http.StatusForbidden, "Forbidden", "forbidden"), true},
		"store 403":        {storeText(http.StatusForbidden, "Forbidden"), false},
		"store 401":        {storeText(http.StatusUnauthorized, "Unauthorized"), false},
		"no endpoints":     {apiStatus(http.StatusServiceUnavailable, "ServiceUnavailable", "no endpoints available"), false},
		"redirect outside": {answer{location: "/api/v1/namespaces/kube-system/secrets"}, false},
	} {
		s, _ := proxyAPIServer(t, map[string]answer{promProxy + "/-/healthy": c.a})
		if got := verifyPrometheusProxy(ctx, s.clientsetCtx(ctx), info); got != c.found {
			t.Errorf("verify, %s: %v", name, got)
		}
	}
}

// OpenCost is read through the API server the same way: no redirect out of its Service, and its own 401 or 403 is the
// store not answering (ErrCostUpstream, 502), while the API server's 403 stays a refusal.
func TestOpenCostProxyReadsFollowTheSameRules(t *testing.T) {
	ctx := context.Background()
	other := newOtherHost(t)
	info := costServiceInfo{Namespace: "opencost", Name: "opencost", Port: 9003}
	alloc := func(a answer) error {
		s, elsewhere := proxyAPIServer(t, map[string]answer{costProxy + "/allocation/compute": a})
		_, _, _, err := s.fetchOpenCostAllocation(ctx, info, "24h", CostAggregateNamespace)
		if seen := elsewhere(); len(seen) != 0 {
			t.Errorf("the API server was asked %v", seen)
		}
		return err
	}
	if err := alloc(answer{location: other.srv.URL + "/allocation/compute"}); !errors.Is(err, ErrCostUpstream) || !strings.Contains(err.Error(), "redirect not followed") {
		t.Errorf("redirect to another host: %v", err)
	}
	if err := alloc(answer{location: "/api/v1/namespaces/opencost/secrets"}); !errors.Is(err, ErrCostUpstream) {
		t.Errorf("redirect outside the Service: %v", err)
	}
	if err := alloc(storeText(http.StatusUnauthorized, "Unauthorized")); !errors.Is(err, ErrCostUpstream) || apierrors.IsUnauthorized(err) {
		t.Errorf("store 401: %v", err)
	}
	if err := alloc(apiStatus(http.StatusForbidden, "Forbidden", "forbidden")); !apierrors.IsForbidden(err) || errors.Is(err, ErrCostUpstream) {
		t.Errorf("API server 403: %v", err)
	}
	if seen := other.requests(); len(seen) != 0 {
		t.Fatalf("another host was sent %d requests: %v", len(seen), seen)
	}
	for name, c := range map[string]struct {
		a     answer
		found bool
	}{
		"healthy":        {storeText(http.StatusOK, "ok"), true},
		"API server 403": {apiStatus(http.StatusForbidden, "Forbidden", "forbidden"), true},
		"store 403":      {storeText(http.StatusForbidden, "Forbidden"), false},
	} {
		s, _ := proxyAPIServer(t, map[string]answer{costProxy + "/healthz": c.a})
		if got := verifyOpenCostProxy(ctx, s.clientsetCtx(ctx), &info); got != c.found {
			t.Errorf("verify, %s: %v", name, got)
		}
	}
}
