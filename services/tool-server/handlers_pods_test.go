package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// Tests that do not stand in for k8s-service reach nothing: the pod paths fall back to kubectl at once.
func init() { k8sServiceURL = "http://127.0.0.1:9" }

const largePodPage = `{"items":[
 {"name":"web-1","namespace":"shop","status":"CrashLoopBackOff","ready":"0/1","restart_count":12,"node_name":"n1"},
 {"name":"job-1","namespace":"ops","status":"Pending","ready":"0/1","restart_count":0,"node_name":""}],
 "total":50010,
 "stats":{"total":50010,"top_reasons":[{"reason":"Running","count":50000},{"reason":"CrashLoopBackOff","count":7}],"health":{"ok":49990,"warn":13,"error":7}},
 "by_namespace":[{"name":"bulk-001","count":500},{"name":"(other)","count":49510}],
 "by_node":[{"name":"n1","count":50},{"name":"(other)","count":49960}],
 "by_phase":[{"name":"Running","count":50003},{"name":"Pending","count":7}]}`

func TestGetResources_ManyPodsAnswerWithCountsAndAPage(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, largePodPage })
	calls := fakeKubectl(t, func([]string) (string, error) { return "", fmt.Errorf("kubectl must not run") })
	out, err := handleGetResources(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "all_namespaces": true, "output": "wide", "offset": 25}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("kubectl ran: %v", *calls)
	}
	r := (*seen)[0]
	q := r.URL.Query()
	if r.URL.Path != "/api/v1/pods/page" || q.Get("sort") != "health" || q.Get("groups") != "1" || q.Get("group_top") != "10" ||
		q.Get("limit") != "25" || q.Get("offset") != "25" || q.Has("namespace") || q.Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s", r.URL.Path, r.URL.RawQuery)
	}
	m := decode(t, out)
	if m["total"] != float64(50010) || m["need_attention"] != float64(20) || m["next_offset"] != float64(27) || m["scope"] != "all namespaces" {
		t.Fatalf("summary: %s", out)
	}
	if pods := fmt.Sprintf("%q", m["pods"]); pods != `["shop/web-1 CrashLoopBackOff ready=0/1 restarts=12 node=n1" "ops/job-1 Pending ready=0/1 restarts=0 node=<none>"]` {
		t.Fatalf("pods: %s", pods)
	}
	// what the answer covers and how to go on come before the long lists, where the model's cut falls
	for _, key := range []string{`"total"`, `"note"`, `"next_offset"`} {
		if strings.Index(out, key) > strings.Index(out, `"by_namespace"`) {
			t.Fatalf("%s after the lists: %s", key, out)
		}
	}
}

func TestGetResources_FewPodsStayKubectl(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"items":[{"name":"web-1","namespace":"shop"}],"total":3,"stats":{"total":3}}`
	})
	table := "NAMESPACE   NAME    READY   STATUS\nshop        web-1   1/1     Running\n"
	calls := fakeKubectl(t, func([]string) (string, error) { return table, nil })
	out, err := handleGetResources(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "namespace": "shop", "output": "wide"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if out != table || len(*calls) != 1 || !has(verb((*calls)[0]), "shop") || (*seen)[0].URL.Query().Get("namespace") != "shop" {
		t.Fatalf("out %q calls %v", out, *calls)
	}
	// a named pod never asks k8s-service
	n := len(*seen)
	if _, err := handleGetResources(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "resource_name": "web-1", "namespace": "shop"}, bearer()); err != nil || len(*seen) != n {
		t.Fatalf("named pod asked k8s-service: %v", err)
	}
}

func TestGetResources_PodsWithoutK8sServiceStayKubectl(t *testing.T) {
	calls := fakeKubectl(t, func([]string) (string, error) { return "listed by kubectl\n", nil })
	out, err := handleGetResources(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "all_namespaces": true}, bearer())
	if err != nil || out != "listed by kubectl\n" || len(*calls) != 1 {
		t.Fatalf("out %q err %v calls %v", out, err, *calls)
	}
}

func TestFindResource_PodsSearchEveryPodRow(t *testing.T) {
	// three pods match; the page holds as many as the limit asks
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		items := `{"name":"web-7d9f-x2k9p","namespace":"shop"}`
		if r.URL.Query().Get("limit") != "1" {
			items += `,{"name":"web-7d9f-a1b2c","namespace":"shop"},{"name":"web-0","namespace":"ops"}`
		}
		return 200, `{"items":[` + items + `],"total":3,"stats":{"total":50010}}`
	})
	calls := fakeKubectl(t, func(args []string) (string, error) {
		if verb(args)[1] == "pods" {
			return "", fmt.Errorf("kubectl listed pods")
		}
		return "shop   web   map[app:web]\n", nil
	})
	out, err := handleFindResource(ctxFor("c1"), map[string]interface{}{"query": "web", "kinds": "pods,deployments", "limit": 5}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if q.Get("q") != "web" || q.Get("match") != "tokens" || q.Get("limit") != "5" || q.Has("label_selector") {
		t.Fatalf("request: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	matches, _ := json.Marshal(m["matches"])
	if string(matches) != `[{"kind":"pods","name":"web-7d9f-x2k9p","namespace":"shop"},{"kind":"pods","name":"web-7d9f-a1b2c","namespace":"shop"},`+
		`{"kind":"pods","name":"web-0","namespace":"ops"},{"kind":"deployments","name":"web","namespace":"shop"}]` || m["truncated"] != false || len(*calls) != 1 {
		t.Fatalf("out %s calls %v", out, *calls)
	}

	out, _ = handleFindResource(ctxFor("c1"), map[string]interface{}{"query": "web", "kinds": "pods,deployments", "limit": 1}, bearer())
	m = decode(t, out)
	if notes, _ := json.Marshal(m["notes"]); m["truncated"] != true || len(m["matches"].([]interface{})) != 1 || !strings.Contains(string(notes), "pods: 3 matched, 1 listed") {
		t.Fatalf("limit: %s", out)
	}

	if _, err := handleFindResource(ctxFor("c1"), map[string]interface{}{"query": "app.kubernetes.io/name=web", "kinds": "pods", "namespace": "shop"}, bearer()); err != nil {
		t.Fatal(err)
	}
	q = (*seen)[2].URL.Query()
	if q.Get("label_selector") != "app.kubernetes.io/name=web" || q.Has("q") || q.Get("namespace") != "shop" {
		t.Fatalf("label request: %s", (*seen)[2].URL.RawQuery)
	}
}

func TestCount_PodsFromThePodRows(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"items":[],"total":50010,"stats":{"total":50010},
 "by_namespace":[{"name":"bulk-001","count":500},{"name":"(other)","count":49510}],
 "by_node":[{"name":"(none)","count":10},{"name":"n1","count":50000}],"by_phase":[{"name":"Running","count":50010}]}`
	})
	calls := fakeKubectl(t, func([]string) (string, error) { return `{"items":[]}`, nil })
	out, err := handleCount(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "group_by": ".metadata.namespace", "label_selector": "app=web"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if q.Get("group_top") != "100" || q.Get("label_selector") != "app=web" || len(*calls) != 0 {
		t.Fatalf("request %s calls %v", (*seen)[0].URL.RawQuery, *calls)
	}
	m := decode(t, out)
	groups, _ := json.Marshal(m["groups"])
	if m["count"] != float64(50010) || m["truncated"] != true || string(groups) != `[{"count":500,"key":"bulk-001"}]` {
		t.Fatalf("count: %s", out)
	}
	out, _ = handleCount(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "group_by": ".spec.nodeName"}, bearer())
	if groups := fmt.Sprint(decode(t, out)["groups"]); groups != "[map[count:10 key:<none>] map[count:50000 key:n1]]" {
		t.Fatalf("no node reads as kubectl's <none>: %s", groups)
	}
	// a field selector or another field is kubectl's
	for _, args := range []map[string]interface{}{
		{"resource_type": "pods", "field_selector": "status.phase=Running"},
		{"resource_type": "pods", "group_by": ".spec.schedulerName"},
	} {
		n := len(*calls)
		if _, err := handleCount(ctxFor("c1"), args, bearer()); err != nil || len(*calls) != n+1 {
			t.Fatalf("%v: kubectl did not count (%v)", args, err)
		}
	}
}

// A list the output cap cut is said to be cut: not an unreadable-JSON error, not a wrong count or total.
func TestQueryTools_CutListIsSaidToBeCut(t *testing.T) {
	cut := `{"items":[{"metadata":{"name":"a"}},{"metadata"` + fmt.Sprintf(truncatedMarker, outputMaxBytes)
	fakeKubectl(t, func([]string) (string, error) { return cut, nil })
	for _, h := range []func() (string, error){
		func() (string, error) {
			return handleCount(ctxFor("c1"), map[string]interface{}{"resource_type": "deployments"}, nil)
		},
		func() (string, error) {
			return handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "deployments", "jq": ".items | length"}, nil)
		},
	} {
		out, err := h()
		if err != nil || decode(t, out)["status"] != "too_large" {
			t.Fatalf("out %s err %v", out, err)
		}
	}
	rows := "NAMESPACE   NAME\nshop   a\nshop   b\nshop   c-partial" + fmt.Sprintf(truncatedMarker, outputMaxBytes)
	fakeKubectl(t, func([]string) (string, error) { return rows, nil })
	out, err := handleTabularQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "deployments"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "the first 2 read. The total is not known") || strings.Contains(out, "c-partial") || strings.Contains(out, ": 2 rows") {
		t.Fatalf("tabular: %s", out)
	}
}

// A pod that is not there: its similar names come from the pod rows near its name, not from a kubectl list of
// every pod (which does not fit tool-server's memory on a large cluster).
func TestNotFound_PodSimilarNamesFromThePodRows(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		switch r.URL.Query().Get("q") {
		case "auth":
			return 200, `{"items":[{"name":"auth-service-69dd8954dc-tk2gm","namespace":"kubeast"},{"name":"oauth2-proxy-0","namespace":"ops"}],"total":2,"stats":{"total":50010}}`
		case "service":
			return 200, `{"items":[{"name":"auth-service-69dd8954dc-tk2gm","namespace":"kubeast"},{"name":"k8s-service-5d4f-x2k9p","namespace":"kubeast"}],"total":900,"stats":{"total":50010}}`
		}
		return 200, `{"items":[],"total":0,"stats":{"total":50010}}`
	})
	calls := fakeKubectl(t, func(args []string) (string, error) {
		v := verb(args)
		switch {
		case v[0] == "describe":
			return kubectlErr(`Error from server (NotFound): pods "auth-service-69dd8954dc-zzzzz" not found`)
		case v[0] == "get" && v[1] == "namespace":
			return "namespace/default\n", nil
		}
		t.Fatalf("kubectl listed pods: %v", v)
		return "", nil
	})
	out, err := handleDescribeResource(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "resource_name": "auth-service-69dd8954dc-zzzzz", "namespace": "default"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	var asked []string
	for _, r := range *seen {
		asked = append(asked, r.URL.Query().Get("q")+"/"+r.URL.Query().Get("match")+"/"+r.URL.Query().Get("limit"))
	}
	if strings.Join(asked, " ") != "auth/tokens/500 service/tokens/500" || len(*calls) != 2 {
		t.Fatalf("asked %v, kubectl %v", asked, *calls)
	}
	m := decode(t, out)
	similar, _ := json.Marshal(m["similar"])
	if m["status"] != "not_found" || m["searched_truncated"] != true || !strings.HasPrefix(string(similar), `[{"name":"auth-service-69dd8954dc-tk2gm","namespace":"kubeast"}`) {
		t.Fatalf("result: %s", out)
	}

	// a stem without a word of three letters is searched whole
	*seen = nil
	fakeKubectl(t, func(args []string) (string, error) {
		if verb(args)[0] == "describe" {
			return kubectlErr(`Error from server (NotFound): pods "db" not found`)
		}
		return "namespace/default\n", nil
	})
	if _, err := handleDescribeResource(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "resource_name": "db", "namespace": "default"}, bearer()); err != nil {
		t.Fatal(err)
	}
	if q := (*seen)[0].URL.Query(); q.Get("q") != "db" || q.Has("match") {
		t.Fatalf("short stem: %s", (*seen)[0].URL.RawQuery)
	}
}
