package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// Through the API server's proxy the answer is what the caller's identity may read: the cache and singleflight key
// carries that identity, so one user's answer — a cluster-wide reader's, an admin's — is never served to another (a
// grant limited to namespaces got the cluster-wide answer for 30 s before). An external store answers Kubeast's own
// credentials alike, so its key is shared.
func TestPromCacheKeyCarriesTheProxyIdentity(t *testing.T) {
	as := func(p *auth.TokenPayload) context.Context {
		ctx := cluster.WithID(context.Background(), "c1")
		if p != nil {
			ctx = context.WithValue(ctx, auth.TokenPayloadContextKey(), *p)
		}
		return ctx
	}
	reader := auth.TokenPayload{UserID: "u1", Email: "ops@example.com", Roles: map[string]string{"c1": "Read"}}
	admin := auth.TokenPayload{UserID: "u2", Email: "lead@example.com", Roles: map[string]string{"c1": "Admin"}}
	scoped := auth.TokenPayload{UserID: "u3", Email: "shop@example.com", Roles: map[string]string{"c1": "Read"}, Namespaces: map[string][]string{"c1": {"shop"}}}
	proxy := &promSource{proxy: &promServiceInfo{Namespace: "monitoring", Name: "prometheus", Port: 9090}}
	ext := &promSource{ext: &promExternal{baseURL: "http://store:9090"}}
	const path = "/api/v1/query?query=up"

	seen := map[string]string{}
	for name, p := range map[string]*auth.TokenPayload{"reader": &reader, "admin": &admin, "scoped": &scoped, "no caller": nil} {
		key := promCacheKey(as(p), proxy, path)
		if other, dup := seen[key]; dup {
			t.Fatalf("%s and %s share the proxy key %q", name, other, key)
		}
		seen[key] = name
		if promCacheKey(as(p), proxy, path) != key {
			t.Fatalf("%s: the key moves between calls", name)
		}
		if promCacheKey(as(p), ext, path) != promCacheKey(as(nil), ext, path) {
			t.Fatalf("%s: the external store's key is not shared", name)
		}
	}

	c := newPromQueryCache(time.Minute)
	calls := 0
	fetch := func() ([]map[string]interface{}, error) {
		calls++
		return []map[string]interface{}{{"metric": map[string]interface{}{"namespace": "kube-system"}}}, nil
	}
	if _, err := c.do(promCacheKey(as(&reader), proxy, path), fetch); err != nil {
		t.Fatal(err)
	}
	if _, err := c.do(promCacheKey(as(&scoped), proxy, path), fetch); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("the namespace-limited caller got the reader's cached answer (%d fetches)", calls)
	}
}

// promStoreAt is a store that counts what it is asked.
func promStoreAt(t *testing.T) (*promSource, *atomic.Int32) {
	t.Helper()
	var asked atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"pod":"web-1"},"value":[1,"2"]}]}}`))
	}))
	t.Cleanup(srv.Close)
	return &promSource{ext: &promExternal{baseURL: srv.URL}}, &asked
}

func asCaller(p auth.TokenPayload) context.Context {
	return auth.WithPayload(cluster.WithID(context.Background(), "c1"), p)
}

func TestAnExternalStoreAnswersOnlyThoseHoldingTheReadPermission(t *testing.T) {
	src, asked := promStoreAt(t)
	s := &Service{promQ: newPromQueryCache(time.Minute)}
	const path = "/api/v1/query?query=up"

	reader := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"c1": {"resource.*.read"}}}
	if rows, err := s.promFetch(asCaller(reader), src, path); err != nil || len(rows) != 1 {
		t.Fatalf("reader: %v, %v", rows, err)
	}
	// Refused before the cache: the reader's answer is cached under the shared key by now.
	unbound := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"c1": {"menu.dashboard"}}}
	rows, err := s.promFetch(asCaller(unbound), src, path)
	if !apierrors.IsForbidden(err) || rows != nil {
		t.Fatalf("no permission: rows %v, err %v, want forbidden", rows, err)
	}
	if _, err := s.promGetData(asCaller(unbound), src, "/api/v1/label/__name__/values"); !apierrors.IsForbidden(err) {
		t.Fatalf("no permission on the explore path: %v", err)
	}
	if asked.Load() != 1 {
		t.Fatalf("store asked %d times", asked.Load())
	}
	// A second holder shares the answer: the key has no identity because the store answers everyone alike.
	other := auth.TokenPayload{UserID: "u3", Perms: auth.PermissionMatrix{"c1": {"resource.pod.read"}}}
	if rows, err := s.promFetch(asCaller(other), src, path); err != nil || len(rows) != 1 {
		t.Fatalf("second holder: %v, %v", rows, err)
	}
	if asked.Load() != 1 {
		t.Fatalf("store asked %d times, want the cached answer", asked.Load())
	}
}

func TestAnExternalStoreStillAnswersKubeastsOwnReads(t *testing.T) {
	src, _ := promStoreAt(t)
	s := &Service{promQ: newPromQueryCache(time.Minute)}
	if rows, err := s.promFetch(cluster.WithID(context.Background(), "c1"), src, "/api/v1/query?query=up"); err != nil || len(rows) != 1 {
		t.Fatalf("%v, %v", rows, err)
	}
}

func TestTheProxyPathLeavesTheAnswerToTheCluster(t *testing.T) {
	src := &promSource{proxy: &promServiceInfo{Namespace: "monitoring", Name: "prometheus", Port: 9090}}
	if err := promExternalRead(asCaller(auth.TokenPayload{Perms: auth.PermissionMatrix{"c1": {"menu.dashboard"}}}), src); err != nil {
		t.Fatal(err)
	}
}
