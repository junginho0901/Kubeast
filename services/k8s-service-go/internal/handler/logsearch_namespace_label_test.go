package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A log store holding container streams beside streams with no namespace label (a node's journal), as a store fed by
// more than container logs does. It answers a read with the streams its first selector matches, as Loki matches
// label matchers: a label a stream does not carry reads as "", and a regex matches the whole value.
type heldStream struct {
	name   string
	labels map[string]string
}

var (
	sharedStore = []heldStream{
		{"app", map[string]string{"k8s_cluster_name": "kubeast", "k8s_namespace_name": "apps", "k8s_pod_name": "web-1", "k8s_container_name": "app", "job": "web"}},
		{"journal", map[string]string{"k8s_cluster_name": "kubeast", "job": "systemd-journal", "host": "node-1"}},
		{"shell", map[string]string{"k8s_cluster_name": "kubeast", "k8s_namespace_name": shellNamespace, "k8s_pod_name": "node-debug-1", "k8s_container_name": "debugger", "job": "shell"}},
		{"other cluster", map[string]string{"k8s_cluster_name": "kubeast-b", "k8s_namespace_name": "apps", "k8s_pod_name": "web-9", "k8s_container_name": "app", "job": "web"}},
	}
	// a cluster's own store, holding that cluster alone with no cluster label
	ownStore = []heldStream{
		{"app", map[string]string{"k8s_namespace_name": "apps", "k8s_pod_name": "web-1", "k8s_container_name": "app", "job": "web"}},
		{"journal", map[string]string{"job": "systemd-journal", "host": "node-1"}},
	}
	labelMatcher = regexp.MustCompile(`([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*")`)
)

// selected is the streams the first selector of query matches.
func selected(streams []heldStream, query string) ([]heldStream, error) {
	open := strings.IndexByte(query, '{')
	end := strings.IndexByte(query, '}')
	if open < 0 || end < open {
		return nil, fmt.Errorf("no selector in %q", query)
	}
	type matcher struct {
		name, op string
		value    string
		re       *regexp.Regexp
	}
	var ms []matcher
	for _, m := range labelMatcher.FindAllStringSubmatch(query[open+1:end], -1) {
		v, err := strconv.Unquote(m[3])
		if err != nil {
			return nil, err
		}
		mm := matcher{name: m[1], op: m[2], value: v}
		if strings.Contains(m[2], "~") {
			if mm.re, err = regexp.Compile("^(?:" + v + ")$"); err != nil {
				return nil, err
			}
		}
		ms = append(ms, mm)
	}
	var out []heldStream
	for _, s := range streams {
		ok := true
		for _, m := range ms {
			v := s.labels[m.name]
			switch m.op {
			case "=":
				ok = ok && v == m.value
			case "!=":
				ok = ok && v != m.value
			case "=~":
				ok = ok && m.re.MatchString(v)
			case "!~":
				ok = ok && !m.re.MatchString(v)
			}
		}
		if ok {
			out = append(out, s)
		}
	}
	return out, nil
}

// heldStreamsStore answers query_range (streams or a matrix), patterns, index stats and label values from streams;
// each stream's line, pattern and series name its stream.
func heldStreamsStore(streams []heldStream) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		picked, err := selected(streams, q)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		var data interface{}
		switch {
		case r.URL.Path == "/loki/api/v1/index/stats":
			n := len(picked)
			_ = json.NewEncoder(w).Encode(map[string]int{"streams": n, "chunks": n, "entries": n, "bytes": 100 * n})
			return
		case r.URL.Path == "/loki/api/v1/patterns":
			out := []interface{}{}
			for _, s := range picked {
				out = append(out, map[string]interface{}{"pattern": s.name, "level": "info", "samples": [][2]int64{{1760443200, 30}}})
			}
			data = out
		case strings.HasSuffix(r.URL.Path, "/values"):
			label := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/loki/api/v1/label/"), "/values")
			seen := map[string]bool{}
			out := []string{}
			for _, s := range picked {
				if v := s.labels[label]; v != "" && !seen[v] {
					seen[v] = true
					out = append(out, v)
				}
			}
			sort.Strings(out)
			data = out
		case strings.HasPrefix(q, "{"):
			result := []interface{}{}
			for i, s := range picked {
				result = append(result, map[string]interface{}{"stream": s.labels, "values": [][2]string{{strconv.FormatInt(1760443200000000000+int64(i), 10), s.name}}})
			}
			data = map[string]interface{}{"resultType": "streams", "result": result, "stats": map[string]interface{}{"summary": map[string]interface{}{"totalBytesProcessed": 64}}}
		default:
			result := []interface{}{}
			for _, s := range picked {
				result = append(result, map[string]interface{}{"metric": map[string]string{"stream": s.name}, "values": [][]interface{}{{1760443200, "1"}}})
			}
			data = map[string]interface{}{"resultType": "matrix", "result": result}
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": data})
	}
}

// newHeldStreamsFixture serves cluster "self" from the shared store (cluster label value kubeast) and cluster "own"
// from its own store with no label value, with LogQL on, the volume estimate on and the node shell namespace set.
func newHeldStreamsFixture(t *testing.T) *logSearchFixture {
	t.Helper()
	f := &logSearchFixture{store: &memAudit{}}
	record := func(streams []heldStream) *httptest.Server {
		answer := heldStreamsStore(streams)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			f.queries = append(f.queries, r.URL.Query().Get("query"))
			answer(w, r)
		}))
		t.Cleanup(srv.Close)
		return srv
	}
	shared, own := record(sharedStore), record(ownStore)
	s, err := logsearch.New(logsearch.Config{
		Enabled: true, Backend: "loki", URL: shared.URL, LogQLEnabled: true, QueryMaxBytes: 1 << 20,
		Labels:       logsearch.Labels{Cluster: "k8s_cluster_name", Namespace: "k8s_namespace_name", Pod: "k8s_pod_name", Container: "k8s_container_name"},
		Clusters:     map[string]string{"self": "kubeast"},
		DefaultRange: time.Hour, MaxRange: 24 * time.Hour, MaxLines: 100, Timeout: 2 * time.Second, PerUserPerMinute: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	s.OwnStore = func(_ context.Context, id string) *logsearch.Store {
		if id == "own" {
			return &logsearch.Store{URL: own.URL}
		}
		return nil
	}
	f.h = &Handler{auditStore: f.store, cfg: config.Config{NodeShellNamespace: shellNamespace}}
	f.h.SetLogSearch(s)
	f.h.logSearchCanI = func(_ context.Context, ns string) (bool, error) {
		f.reviews = append(f.reviews, ns)
		return true, nil
	}
	return f
}

// The reads across namespaces, as the routes serve them: structured search first, the one the others are held to.
var readsAcrossNamespaces = []struct {
	name  string
	path  string
	q     string
	serve func(*Handler) http.HandlerFunc
}{
	{"structured search", "/api/v1/logsearch", "", func(h *Handler) http.HandlerFunc { return h.LogSearchAll }},
	{"the screen's LogQL", "/api/v1/logsearch/query", `{job=~".+"}`, func(h *Handler) http.HandlerFunc { return h.LogQLAll }},
	{"loki_query lines", "/api/v1/logsearch/logql", `{job=~".+"} | logfmt`, func(h *Handler) http.HandlerFunc { return h.LogQLSearchAll }},
	{"loki_query a metric", "/api/v1/logsearch/logql", `sum by (job) (count_over_time({job=~".+"}[5m]))`, func(h *Handler) http.HandlerFunc { return h.LogQLSearchAll }},
	{"loki_patterns", "/api/v1/logsearch/patterns", `{job=~".+"}`, func(h *Handler) http.HandlerFunc { return h.LogPatternsAll }},
}

// streamsRead names the streams an answer holds: its lines, series or patterns.
func streamsRead(t *testing.T, body []byte) []string {
	t.Helper()
	var res struct {
		Lines    []struct{ Line string }              `json:"lines"`
		Series   []struct{ Metric map[string]string } `json:"series"`
		Patterns []struct{ Pattern string }           `json:"patterns"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	var out []string
	for _, l := range res.Lines {
		out = append(out, l.Line)
	}
	for _, s := range res.Series {
		out = append(out, s.Metric["stream"])
	}
	for _, p := range res.Patterns {
		out = append(out, p.Pattern)
	}
	sort.Strings(out)
	return out
}

// A query written by hand or by the AI across namespaces, whose selector names no namespace, reads what a structured
// search reads: no stream without a namespace label, the node shell's only for its holders, no other cluster's — on a
// store several clusters share and on a cluster's own store with no label value alike.
func TestReadsAcrossNamespacesReadTheStreamsAStructuredSearchReads(t *testing.T) {
	want := map[string]string{
		"self a pod reader":      "app",
		"self a node shell user": "app,shell",
		"own a pod reader":       "app",
		"own a node shell user":  "app",
	}
	for _, cluster := range []string{"self", "own"} {
		for who, payload := range map[string]auth.TokenPayload{"a pod reader": podReader, "a node shell user": shellHolder} {
			key := cluster + " " + who
			for _, read := range readsAcrossNamespaces {
				f := newHeldStreamsFixture(t)
				target := read.path + "?since=1h"
				if read.q != "" {
					target = logqlTarget(read.path, read.q, "&since=1h&step=300")
				}
				w := httptest.NewRecorder()
				read.serve(f.h)(w, logSearchRequestAs(target, cluster, "", payload))
				if w.Code != http.StatusOK {
					t.Fatalf("%s, %s: %d %s", key, read.name, w.Code, w.Body)
				}
				if got := strings.Join(streamsRead(t, w.Body.Bytes()), ","); got != want[key] {
					t.Errorf("%s, %s: read %q, want %q (sent %q)", key, read.name, got, want[key], f.queries)
				}
				// the door is the one it was: the cluster asked for pod logs in every namespace, once
				if len(f.reviews) != 1 || f.reviews[0] != "" {
					t.Errorf("%s, %s: pods/log reviews %q", key, read.name, f.reviews)
				}
			}
		}
	}
}

// A selector that asks for the node's journal by name, or for streams with no namespace label, reads nothing across
// namespaces; the volume estimate asks the index for the namespaced streams only.
func TestAQueryAcrossNamespacesCannotAskForStreamsWithoutANamespaceLabel(t *testing.T) {
	for _, q := range []string{`{job="systemd-journal"}`, `{host="node-1"}`, `{k8s_namespace_name=""}`, `{k8s_namespace_name!~".+"}`} {
		for _, cluster := range []string{"self", "own"} {
			f := newHeldStreamsFixture(t)
			w := httptest.NewRecorder()
			f.h.LogQLSearchAll(w, logSearchRequestAs(logqlTarget("/api/v1/logsearch/logql", q, "&since=1h"), cluster, "", shellHolder))
			var res logsearch.Result
			if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || w.Code != http.StatusOK {
				t.Fatalf("%s %s: %d %s", cluster, q, w.Code, w.Body)
			}
			if len(res.Lines) != 0 || !strings.Contains(res.EffectiveQuery, `k8s_namespace_name=~".+"`) {
				t.Errorf("%s %s: %d lines, sent %q", cluster, q, len(res.Lines), res.EffectiveQuery)
			}
			// the index was asked first (queryMaxBytes), with the same selector, and counted no stream
			if res.EstimatedBytes == nil || *res.EstimatedBytes != 0 || len(f.queries) != 2 || f.queries[0] != res.EffectiveQuery {
				t.Errorf("%s %s: estimate %v, sent %q", cluster, q, res.EstimatedBytes, f.queries)
			}
		}
	}

	f := newHeldStreamsFixture(t)
	w := httptest.NewRecorder()
	f.h.LogQLSearchAll(w, logSearchRequestAs(logqlTarget("/api/v1/logsearch/logql", `{job=~".+"}`, "&since=1h"), "self", "", podReader))
	var res logsearch.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res.EstimatedBytes == nil || *res.EstimatedBytes != 100 {
		t.Fatalf("the index counted %v bytes, want one stream's 100: sent %q", res.EstimatedBytes, f.queries)
	}
}

// Who may read across namespaces is as it was: a grant limited to namespaces is refused every one of these reads
// before the store or the cluster is asked.
func TestAGrantLimitedToNamespacesIsStillRefusedEveryReadAcrossNamespaces(t *testing.T) {
	scoped := podReader
	scoped.Namespaces = map[string][]string{"self": {"apps"}}
	for _, read := range readsAcrossNamespaces {
		f := newHeldStreamsFixture(t)
		target := read.path + "?since=1h"
		if read.q != "" {
			target = logqlTarget(read.path, read.q, "&since=1h")
		}
		w := httptest.NewRecorder()
		read.serve(f.h)(w, logSearchRequestAs(target, "self", "", scoped))
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "limited to namespaces") || len(f.queries) != 0 || len(f.reviews) != 0 {
			t.Errorf("%s: %d %s, store asked %d times, cluster %d", read.name, w.Code, w.Body, len(f.queries), len(f.reviews))
		}
	}
}
