package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const shellNamespace = "kubeast-node-shell"

// lokiWithAShell answers as a store that collected every namespace: the node shell's terminal output comes back unless
// the query leaves that namespace out.
func lokiWithAShell(w http.ResponseWriter, r *http.Request) {
	streams := []interface{}{map[string]interface{}{
		"stream": map[string]string{"k8s_namespace_name": "apps", "k8s_pod_name": "web-1", "k8s_container_name": "app"},
		"values": [][2]string{{"1760443200000000000", "an application line"}},
	}}
	if !strings.Contains(r.URL.Query().Get("query"), `k8s_namespace_name!="`+shellNamespace+`"`) {
		streams = append(streams, map[string]interface{}{
			"stream": map[string]string{"k8s_namespace_name": shellNamespace, "k8s_pod_name": "node-debug-1", "k8s_container_name": "debugger"},
			"values": [][2]string{{"1760443200000000001", "what the shell printed"}},
		})
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": map[string]interface{}{
		"resultType": "streams", "result": streams, "stats": map[string]interface{}{"summary": map[string]interface{}{"totalBytesProcessed": 64}},
	}})
}

func shellFixture(t *testing.T, loki http.HandlerFunc) *logSearchFixture {
	t.Helper()
	f := newLogQLFixture(t, loki)
	f.h.cfg = config.Config{NodeShellNamespace: shellNamespace}
	return f
}

var (
	shellHolder  = auth.TokenPayload{UserID: "u9", Perms: auth.PermissionMatrix{"*": {"resource.pod.read", "resource.node.shell"}}}
	shellOnOther = auth.TokenPayload{UserID: "u8", Perms: auth.PermissionMatrix{"self": {"resource.pod.read"}, "other": {"resource.node.shell"}}}
)

// Every read of the store across namespaces, as the routes serve them.
var acrossNamespaces = []struct {
	name   string
	target string
	serve  func(*Handler) http.HandlerFunc
}{
	{"search", "/api/v1/logsearch?q=printed", func(h *Handler) http.HandlerFunc { return h.LogSearchAll }},
	{"the screen's LogQL", logqlTarget("/api/v1/logsearch/query", `{app="x"}`, ""), func(h *Handler) http.HandlerFunc { return h.LogQLAll }},
	{"the tools' LogQL", logqlTarget("/api/v1/logsearch/logql", `{app="x"}`, ""), func(h *Handler) http.HandlerFunc { return h.LogQLSearchAll }},
}

func TestAReaderAcrossNamespacesGetsNoNodeShellLines(t *testing.T) {
	for _, c := range acrossNamespaces {
		for name, who := range map[string]auth.TokenPayload{"a pod reader": podReader, "a holder on another cluster only": shellOnOther} {
			t.Run(c.name+", "+name, func(t *testing.T) {
				f := shellFixture(t, lokiWithAShell)
				w := httptest.NewRecorder()
				c.serve(f.h)(w, logSearchRequestAs(c.target, "self", "", who))
				if w.Code != http.StatusOK {
					t.Fatalf("%d %s", w.Code, w.Body)
				}
				if strings.Contains(w.Body.String(), "what the shell printed") {
					t.Errorf("the shell's output came back: %s", w.Body)
				}
				if !strings.Contains(w.Body.String(), "an application line") {
					t.Errorf("the other lines went too: %s", w.Body)
				}
			})
		}
	}
}

func TestHoldingTheNodeShellPermissionKeepsThoseLines(t *testing.T) {
	for _, c := range acrossNamespaces {
		t.Run(c.name, func(t *testing.T) {
			f := shellFixture(t, lokiWithAShell)
			w := httptest.NewRecorder()
			c.serve(f.h)(w, logSearchRequestAs(c.target, "self", "", shellHolder))
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "what the shell printed") {
				t.Errorf("%d %s", w.Code, w.Body)
			}
			if strings.Contains(f.queries[0], "!=") {
				t.Errorf("query %q", f.queries[0])
			}
		})
	}
}

// A query that names the namespace itself reads nothing of it: the store ANDs the two matchers.
func TestAQueryNamingTheNamespaceIsLimitedToo(t *testing.T) {
	f := shellFixture(t, lokiWithAShell)
	w := httptest.NewRecorder()
	f.h.LogQLAll(w, logSearchRequestAs(logqlTarget("/api/v1/logsearch/query", `{k8s_namespace_name="`+shellNamespace+`"}`, ""), "self", "", podReader))
	if w.Code != http.StatusOK || !strings.Contains(f.queries[0], `k8s_namespace_name!="`+shellNamespace+`"`) {
		t.Errorf("%d sent %q", w.Code, f.queries[0])
	}
}

func TestAMetricQueryAcrossNamespacesLeavesTheShellOut(t *testing.T) {
	f := shellFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
	})
	w := httptest.NewRecorder()
	f.h.LogQLSearchAll(w, logSearchRequestAs(logqlTarget("/api/v1/logsearch/logql", `sum(rate({app="x"}[5m]))`, "&step=60"), "self", "", podReader))
	if w.Code != http.StatusOK || !strings.Contains(f.queries[0], `k8s_namespace_name!="`+shellNamespace+`"`) {
		t.Errorf("%d sent %q", w.Code, f.queries[0])
	}
}

func TestLabelsAcrossNamespacesLeaveTheShellOut(t *testing.T) {
	f := shellFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":["apps"]}`))
	})
	w := httptest.NewRecorder()
	f.h.LogLabelsAll(w, logSearchRequestAs("/api/v1/logsearch/labels?label=k8s_namespace_name", "self", "", podReader))
	if w.Code != http.StatusOK || !strings.Contains(f.queries[0], `k8s_namespace_name!="`+shellNamespace+`"`) {
		t.Errorf("%d sent %q", w.Code, f.queries[0])
	}
}

func TestPatternsAcrossNamespacesLeaveTheShellOut(t *testing.T) {
	f := shellFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":[]}`))
	})
	w := httptest.NewRecorder()
	f.h.LogPatternsAll(w, logSearchRequestAs(logqlTarget("/api/v1/logsearch/patterns", `{app="x"}`, ""), "self", "", podReader))
	if w.Code != http.StatusOK || !strings.Contains(f.queries[0], `k8s_namespace_name!="`+shellNamespace+`"`) {
		t.Errorf("%d sent %q", w.Code, f.queries[0])
	}
}

// A search of one namespace reads that namespace, as it did.
func TestASearchOfOneNamespaceSendsWhatItAlwaysSent(t *testing.T) {
	f := shellFixture(t, lokiAnswers("an application line"))
	w := f.do(logSearchRequestAs("/api/v1/namespaces/apps/logsearch?q=line", "self", "apps", podReader), "apps")
	want := `{k8s_cluster_name="kubeast", k8s_namespace_name="apps"} |= "line"`
	if w.Code != http.StatusOK || f.queries[0] != want {
		t.Errorf("%d sent %q", w.Code, f.queries[0])
	}
}

// A search's answer has no query in it, so it says what it left out, and so does its audit row.
func TestASearchAcrossNamespacesSaysWhatItLeftOut(t *testing.T) {
	f := shellFixture(t, lokiWithAShell)
	w := f.do(logSearchRequestAs("/api/v1/logsearch?q=line", "self", "", podReader), "")
	var res logsearch.Result
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.HiddenNamespace != shellNamespace {
		t.Errorf("answer %s", w.Body)
	}
	if rows := f.store.rows; len(rows) != 1 || !strings.Contains(string(rows[0].After), `"hidden_namespace":"`+shellNamespace+`"`) {
		t.Errorf("rows %+v", rows)
	}

	f = shellFixture(t, lokiWithAShell)
	w = f.do(logSearchRequestAs("/api/v1/logsearch?q=line", "self", "", shellHolder), "")
	if strings.Contains(w.Body.String(), "hiddenNamespace") || strings.Contains(string(f.store.rows[0].After), "hidden_namespace") {
		t.Errorf("nothing was left out: %s %s", w.Body, f.store.rows[0].After)
	}
}

func TestTheAnswerStillNamesWhatWasAsked(t *testing.T) {
	f := shellFixture(t, lokiWithAShell)
	w := httptest.NewRecorder()
	f.h.LogQLAll(w, logSearchRequestAs(logqlTarget("/api/v1/logsearch/query", `{app="x"}`, ""), "self", "", podReader))
	var res logsearch.Result
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.EffectiveQuery != f.queries[0] {
		t.Errorf("the screen shows %q, the store was sent %q", res.EffectiveQuery, f.queries[0])
	}
}
