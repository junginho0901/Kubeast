package k8s

import (
	"context"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
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
