package logsearch

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A store that records what it was asked and answers one stream.
type fakeStore struct {
	srv     *httptest.Server
	hits    int
	headers http.Header
	query   string
	status  int
}

func newFakeStore(t *testing.T) *fakeStore {
	t.Helper()
	f := &fakeStore{status: http.StatusOK}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits++
		f.headers = r.Header.Clone()
		f.query = r.URL.Query().Get("query")
		if f.status != http.StatusOK {
			w.WriteHeader(f.status)
			_, _ = w.Write([]byte("no org id"))
			return
		}
		if r.URL.Path == "/loki/api/v1/labels" {
			_, _ = w.Write([]byte(`{"status":"success","data":["k8s_namespace_name"]}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"streams","result":[{"stream":{"k8s_namespace_name":"apps","k8s_pod_name":"web-0","k8s_container_name":"app"},"values":[["1760443200000000000","hello"]]}],"stats":{"summary":{"totalBytesProcessed":5}}}}`))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func ownStoreSearcher(t *testing.T, global, own *fakeStore) *Searcher {
	t.Helper()
	s, err := New(testConfig(global.srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	s.OwnStore = func(_ context.Context, id string) *Store {
		switch id {
		case "own": // not in the deployment-wide map; a multi-tenant store holding it alone
			return &Store{URL: own.srv.URL, AuthHeader: "Bearer t", Tenant: "team-a"}
		case "self": // in the map too; its own store wins, with its own label value
			return &Store{URL: own.srv.URL, ClusterLabel: "kubeast-prod"}
		}
		return nil
	}
	s.OwnStoreClusters = func(context.Context) []string { return []string{"own", "self"} }
	return s
}

func TestSearchGoesToTheClusterOwnStoreFirst(t *testing.T) {
	global, own := newFakeStore(t), newFakeStore(t)
	s := ownStoreSearcher(t, global, own)
	ctx := context.Background()
	at := time.Date(2026, 10, 15, 1, 0, 0, 0, time.UTC)
	req := func(cluster string) Request {
		return Request{Cluster: cluster, Namespace: "apps", Start: at.Add(-time.Hour), End: at, Limit: 10}
	}

	if !s.Configured(ctx, "own") || !s.Configured(ctx, "self") || !s.Configured(ctx, "b") || s.Configured(ctx, "nope") {
		t.Fatal("configured: own and self (own stores), b (deployment-wide map), not nope")
	}
	if got := s.ClusterIDs(ctx); strings.Join(got, ",") != "b,own,self" {
		t.Fatalf("cluster ids %v", got)
	}

	res, err := s.Search(ctx, req("own"))
	if err != nil || len(res.Lines) != 1 || res.Lines[0].Line != "hello" {
		t.Fatalf("own: %+v %v", res, err)
	}
	if own.hits != 1 || global.hits != 0 {
		t.Fatalf("own store hit %d times, the deployment-wide one %d", own.hits, global.hits)
	}
	if own.headers.Get("Authorization") != "Bearer t" || own.headers.Get("X-Scope-OrgID") != "team-a" {
		t.Fatalf("own store headers %v", own.headers)
	}
	if strings.Contains(own.query, "k8s_cluster_name") {
		t.Fatalf("a store holding the cluster alone gets no cluster matcher: %s", own.query)
	}

	if _, err := s.Search(ctx, req("self")); err != nil {
		t.Fatal(err)
	}
	if own.hits != 2 || global.hits != 0 || !strings.Contains(own.query, `k8s_cluster_name="kubeast-prod"`) {
		t.Fatalf("self goes to its own store with its own label value: hits %d/%d, query %s", own.hits, global.hits, own.query)
	}
	if own.headers.Get("Authorization") != "" || own.headers.Get("X-Scope-OrgID") != "" {
		t.Fatalf("no credentials or tenant were named for self: %v", own.headers)
	}

	if _, err := s.Search(ctx, req("b")); err != nil {
		t.Fatal(err)
	}
	if global.hits != 1 || own.hits != 2 || !strings.Contains(global.query, `k8s_cluster_name="kubeast-b"`) {
		t.Fatalf("b goes to the deployment-wide store with the map's value: hits %d/%d, query %s", global.hits, own.hits, global.query)
	}

	if _, err := s.Search(ctx, req("nope")); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("nope: %v", err)
	}
}

func TestStatusSaysWhichStoreAndWhetherItAnswers(t *testing.T) {
	global, own := newFakeStore(t), newFakeStore(t)
	s := ownStoreSearcher(t, global, own)
	ctx := context.Background()

	st := s.Status(ctx, "own")
	if st["available"] != true || st["source"] != "cluster" || st["endpoint"] != own.srv.URL || st["auth"] != true || st["tenant"] != "team-a" || st["cluster_label"] != "" {
		t.Fatalf("own: %v", st)
	}
	if st := s.Status(ctx, "b"); st["available"] != true || st["source"] != "global" || st["endpoint"] != global.srv.URL || st["cluster_label"] != "kubeast-b" || st["label_name"] != "k8s_cluster_name" {
		t.Fatalf("b: %v", st)
	}
	if st := s.Status(ctx, "nope"); st["available"] != false || st["source"] != "none" || st["message"] == "" {
		t.Fatalf("nope: %v", st)
	}
	own.status = http.StatusUnauthorized
	if st := s.Status(ctx, "own"); st["available"] != false || !strings.Contains(st["message"].(string), "401") {
		t.Fatalf("a store that refuses shows in the status: %v", st)
	}
}

func TestValidateWithoutADeploymentWideStore(t *testing.T) {
	c := testConfig("")
	c.Clusters = map[string]string{}
	if err := c.Validate(); err != nil {
		t.Fatalf("no deployment-wide store (every cluster names its own): %v", err)
	}
	c.Clusters = map[string]string{"self": "kubeast"}
	if err := c.Validate(); err == nil {
		t.Fatal("clusters without a URL: accepted")
	}
	only, err := New(c)
	if err == nil {
		t.Fatal(only)
	}
}
