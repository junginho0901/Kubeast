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

func TestSelectorsAreTheOnesInjectMatchersRewrites(t *testing.T) {
	q := `sum(rate({app="web"}[5m])) / sum(rate({app="web"}[5m])) + count_over_time({app="api"} |= "{x}" [1m]) # {app="c"}`
	got, err := Selectors(q)
	if err != nil || strings.Join(got, " ") != `{app="web"} {app="api"}` {
		t.Fatalf("%q %v", got, err)
	}
	effective, _ := InjectMatchers(`{} |= "x"`, scope)
	if got, _ := Selectors(effective); len(got) != 1 || got[0] != `{`+scopeText+`}` {
		t.Fatalf("%q", got)
	}
	if _, err := Selectors(`{app="web"`); !errors.Is(err, ErrInvalidLogQL) {
		t.Fatalf("%v", err)
	}
}

func TestEstimateSumsTheIndexOfEachSelector(t *testing.T) {
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/loki/api/v1/index/stats" {
			http.NotFound(w, r)
			return
		}
		asked = append(asked, r.URL.Query().Get("query"))
		_, _ = w.Write([]byte(`{"streams":2,"chunks":3,"entries":40,"bytes":1536}`))
	}))
	defer srv.Close()
	s, err := New(testConfig(srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	end := time.Now()
	vol, effective, err := s.Estimate(context.Background(), QueryRequest{Cluster: "self", Namespace: "apps", Query: `sum(rate({app="web"}[5m])) / sum(rate({app="api"}[5m]))`, Start: end.Add(-time.Hour), End: end})
	if err != nil {
		t.Fatal(err)
	}
	if vol != (Volume{Streams: 4, Chunks: 6, Entries: 80, Bytes: 3072}) || !strings.Contains(effective, `{`+`k8s_cluster_name="kubeast", k8s_namespace_name="apps", app="api"}`) {
		t.Fatalf("%+v %s", vol, effective)
	}
	if len(asked) != 2 || asked[0] != `{k8s_cluster_name="kubeast", k8s_namespace_name="apps", app="web"}` {
		t.Fatalf("the index was asked %q: each selector once, with the scope", asked)
	}

	many := ""
	for i := 0; i <= MaxEstimatedSelectors; i++ {
		many += `count_over_time({a="` + string(rune('a'+i)) + `"}[1m]) + `
	}
	if _, _, err := s.Estimate(context.Background(), QueryRequest{Cluster: "self", Query: many + `vector(0)`, Start: end.Add(-time.Hour), End: end}); !errors.Is(err, ErrInvalidLogQL) {
		t.Fatalf("more selectors than are estimated: %v", err)
	}

	gone := httptest.NewServer(http.NotFoundHandler())
	defer gone.Close()
	old, _ := New(testConfig(gone.URL))
	if _, _, err := old.Estimate(context.Background(), QueryRequest{Cluster: "self", Query: `{app="web"}`, Start: end.Add(-time.Hour), End: end}); !errors.Is(err, ErrNotServed) {
		t.Fatalf("a store without index stats: %v", err)
	}
}

func TestPatternSamplesKeepEachBucket(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":[{"pattern":"error <_>","level":"error","samples":[[1760443200,3],[1760443210,3.5],[1760443220,4]]}]}`))
	}))
	defer srv.Close()
	s, _ := New(testConfig(srv.URL))
	got, effective, err := s.PatternSamples(context.Background(), QueryRequest{Cluster: "self", Namespace: "apps", Query: `{}`, Start: time.Unix(1760440000, 0), End: time.Unix(1760450000, 0)})
	if err != nil || len(got) != 1 || got[0].Level != "error" || len(got[0].Samples) != 2 || got[0].Samples[1] != [2]int64{1760443220, 4} ||
		effective != `{k8s_cluster_name="kubeast", k8s_namespace_name="apps"}` {
		t.Fatalf("%+v %s %v", got, effective, err)
	}
}

func TestSizeReadsAsPeopleRead(t *testing.T) {
	for b, want := range map[int64]string{512: "512 B", 2048: "2.0 KiB", 10 << 30: "10.0 GiB", 3 << 40: "3.0 TiB"} {
		if got := Size(b); got != want {
			t.Errorf("%d: %s, want %s", b, got, want)
		}
	}
}

func TestQueryMaxBytesIsAWholeNumber(t *testing.T) {
	t.Setenv("LOG_SEARCH_QUERY_MAX_BYTES", "")
	if LoadConfig().QueryMaxBytes != 0 {
		t.Fatal("unset is 0")
	}
	t.Setenv("LOG_SEARCH_QUERY_MAX_BYTES", "10737418240")
	if LoadConfig().QueryMaxBytes != 10<<30 {
		t.Fatal(LoadConfig().QueryMaxBytes)
	}
	t.Setenv("LOG_SEARCH_QUERY_MAX_BYTES", "10Gi")
	c := testConfig("http://loki:3100")
	c.QueryMaxBytes = LoadConfig().QueryMaxBytes
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "LOG_SEARCH_QUERY_MAX_BYTES") {
		t.Fatalf("%v", err)
	}
}
