package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

const apiResourcesTable = `NAME          SHORTNAMES   APIVERSION         NAMESPACED   KIND
configmaps    cm           v1                 true         ConfigMap
events        ev           v1                 true         Event
nodes         no           v1                 false        Node
deployments   deploy       apps/v1            true         Deployment
events                     events.k8s.io/v1   true         Event
`

// bigCluster fakes kubectl for a cluster of 110 000 events and 3 ConfigMaps: api-resources, get --raw of a list path
// (limit, continue, the API server's remainingItemCount, which a selector leaves out; a selector matches every
// tenth event), and the plain lists the tools run. It returns the calls.
func bigCluster(t *testing.T) *[][]string {
	t.Helper()
	apiResourcesMu.Lock()
	apiResourcesCache = map[string]apiResourcesEntry{}
	apiResourcesMu.Unlock()
	t.Cleanup(func() {
		apiResourcesMu.Lock()
		apiResourcesCache = map[string]apiResourcesEntry{}
		apiResourcesMu.Unlock()
	})
	return fakeKubectl(t, func(args []string) (string, error) {
		v := verb(args)
		switch {
		case len(v) > 0 && v[0] == "api-resources":
			return apiResourcesTable, nil
		case len(v) > 2 && v[0] == "get" && v[1] == "--raw":
			u, _ := url.Parse(v[2])
			q := u.Query()
			total := 3
			if strings.HasSuffix(u.Path, "/events") {
				total = 110000
			}
			selected := q.Get("labelSelector") != "" || q.Get("fieldSelector") != ""
			if selected {
				total /= 10
			}
			limit, _ := strconv.Atoi(q.Get("limit"))
			from, _ := strconv.Atoi(q.Get("continue"))
			to := from + limit
			if limit == 0 || to > total {
				to = total
			}
			items := make([]string, to-from)
			for i := range items {
				items[i] = `{}`
			}
			meta := map[string]interface{}{}
			if to < total {
				meta["continue"] = strconv.Itoa(to)
				if !selected {
					meta["remainingItemCount"] = total - to
				}
			}
			m, _ := json.Marshal(meta)
			return fmt.Sprintf(`{"kind":"List","metadata":%s,"items":[%s]}`, m, strings.Join(items, ",")), nil
		case len(v) > 1 && v[0] == "get" && v[1] == "events":
			t.Fatalf("kubectl listed the events whole: %v", v)
		}
		return `{"items":[{"metadata":{"name":"a"}},{"metadata":{"name":"b"}},{"metadata":{"name":"c"}}]}`, nil
	})
}

func rawCalls(calls [][]string) []string {
	var out []string
	for _, c := range calls {
		if v := verb(c); len(v) > 2 && v[1] == "--raw" {
			out = append(out, v[2])
		}
	}
	return out
}

func TestListPathFromAPIResources(t *testing.T) {
	bigCluster(t)
	ctx := ctxFor("c1")
	for _, c := range []struct {
		kind, ns string
		all      bool
		want     string
	}{
		{"events", "bulk", false, "/api/v1/namespaces/bulk/events"},
		{"Event", "", true, "/api/v1/events"},
		{"ev", "", false, "/api/v1/namespaces/default/events"},
		{"event", "shop", false, "/api/v1/namespaces/shop/events"},
		{"nodes", "bulk", false, "/api/v1/nodes"},
		{"deploy", "", false, "/apis/apps/v1/namespaces/default/deployments"},
		{"deployments.apps", "", true, "/apis/apps/v1/deployments"},
		{"events.events.k8s.io", "", true, "/apis/events.k8s.io/v1/events"},
	} {
		got, ok, err := listPath(ctx, nil, c.kind, c.ns, c.all)
		if err != nil || !ok || got != c.want {
			t.Errorf("%s in %q all=%v: %q %v %v, want %q", c.kind, c.ns, c.all, got, ok, err, c.want)
		}
	}
	if _, ok, _ := listPath(ctx, nil, "rollouts", "", true); ok {
		t.Fatal("a kind the cluster does not serve has no path")
	}
}

func TestListSizeAsksTheAPIServer(t *testing.T) {
	calls := bigCluster(t)
	ctx := ctxFor("c1")
	// no selector: one GET with limit=1, the count from remainingItemCount
	size, ok, err := listSize(ctx, nil, "events", "", true, "", "")
	if err != nil || !ok || size.count != 110000 || size.atLeast {
		t.Fatalf("size %+v ok %v err %v", size, ok, err)
	}
	if raw := rawCalls(*calls); len(raw) != 1 || !strings.Contains(raw[0], "limit=1") {
		t.Fatalf("raw calls %v", raw)
	}
	// a selector: counted listSizePage at a time, stopping past listMax (11 000 match)
	*calls = nil
	size, _, _ = listSize(ctx, nil, "events", "", true, "", "type=Warning")
	if size.count <= listMax || !size.atLeast {
		t.Fatalf("selector size %+v", size)
	}
	if raw := rawCalls(*calls); len(raw) != listMax/listSizePage+1 {
		t.Fatalf("selector pages %d: %v", len(raw), raw)
	}
	// a small selected list: counted exactly in one page
	*calls = nil
	size, _, _ = listSize(ctx, nil, "configmaps", "shop", false, "app=web", "")
	if size.count != 0 || size.atLeast || len(rawCalls(*calls)) != 1 {
		t.Fatalf("small size %+v, calls %v", size, rawCalls(*calls))
	}
}

func TestBigListToolsAnswerTheSizeWithoutKubectlListing(t *testing.T) {
	bigCluster(t)
	ctx := ctxFor("c1")
	// how many: the API server's count, at any size
	out, err := handleCount(ctx, map[string]interface{}{"resource_type": "events"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["count"] != float64(110000) || m["scope"] != "all namespaces" {
		t.Fatalf("count: %s", out)
	}
	// a selector past listMax: a lower bound, said so
	out, _ = handleCount(ctx, map[string]interface{}{"resource_type": "events", "field_selector": "type=Warning"}, nil)
	if m := decode(t, out); m["count_at_least"] == nil || m["count_at_least"].(float64) <= listMax || m["note"] == nil {
		t.Fatalf("count with a selector: %s", out)
	}
	// the tools that list whole: too_large with the count, kubectl not run
	for name, call := range map[string]func() (string, error){
		"jq": func() (string, error) {
			return handleJQQuery(ctx, map[string]interface{}{"resource_type": "events", "jq": ".items | length"}, nil)
		},
		"table": func() (string, error) {
			return handleTabularQuery(ctx, map[string]interface{}{"resource_type": "events"}, nil)
		},
		"count by a field": func() (string, error) {
			return handleCount(ctx, map[string]interface{}{"resource_type": "events", "group_by": ".reason"}, nil)
		},
		"get": func() (string, error) {
			return handleGetResources(ctx, map[string]interface{}{"resource_type": "events", "all_namespaces": true}, nil)
		},
	} {
		out, err := call()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		m := decode(t, out)
		if m["status"] != "too_large" || m["count"] != float64(110000) || !strings.Contains(m["hint"].(string), "k8s_count") {
			t.Fatalf("%s: %s", name, out)
		}
	}
	// a small list still runs kubectl as before
	out, err = handleJQQuery(ctx, map[string]interface{}{"resource_type": "configmaps", "namespace": "shop", "jq": ".items | length"}, nil)
	if err != nil || !strings.Contains(out, `"results":[3]`) {
		t.Fatalf("small jq: %s %v", out, err)
	}
}

func TestGetEventsNewestOfMany(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"items":[{"namespace":"bulk","type":"Warning","reason":"BackOff","message":"m","count":3,` +
			`"last_timestamp":"2026-10-30T04:00:00Z","involved_object":{"kind":"Pod","name":"web-1"}}],"total":76604}`
	})
	out, err := handleGetEvents(ctxFor("c1"), map[string]interface{}{"namespace": "bulk", "limit": 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	events, _ := m["events"].([]interface{})
	if m["total"] != float64(76604) || m["shown"] != float64(1) || len(events) != 1 || !strings.Contains(m["note"].(string), "newest 1 of 76604") {
		t.Fatalf("answer: %s", out)
	}
	ev := events[0].(map[string]interface{})
	if ev["reason"] != "BackOff" || ev["object"].(map[string]interface{})["name"] != "web-1" || ev["namespace"] != "bulk" {
		t.Fatalf("event: %v", ev)
	}
	if q := (*seen)[0].URL.Query(); q.Get("limit") != "1" || q.Get("namespace") != "bulk" {
		t.Fatalf("asked %s", (*seen)[0].URL)
	}
}
