package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// A namespace's report whose results name several resources (as the wgpolicyk8s.io API allows), and cluster reports
// about a Namespace (its scope) and two ClusterRoles (one result naming both).
const prShopConfig = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"PolicyReport","metadata":{"name":"r-config","namespace":"shop"},"results":[` +
	`{"policy":"need-team","result":"fail","source":"kyverno","message":"cm-a and cm-b need the label team","resources":[{"apiVersion":"v1","kind":"ConfigMap","name":"cm-a","namespace":"shop"},{"apiVersion":"v1","kind":"ConfigMap","name":"cm-b"}]},` +
	`{"policy":"no-plain-secret","result":"warn","source":"kyverno","resources":[{"apiVersion":"v1","kind":"ConfigMap","name":"cm-b","namespace":"shop"},{"apiVersion":"v1","kind":"Secret","name":"s-1","namespace":"shop"},{"kind":"ConfigMap"}]},` +
	`{"policy":"need-team","result":"pass","source":"kyverno","resources":[{"apiVersion":"v1","kind":"Service","name":"web","namespace":"shop"}]}]}`
const cprShopNS = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"ClusterPolicyReport","metadata":{"name":"r-ns-shop"},"scope":{"apiVersion":"v1","kind":"Namespace","name":"shop"},"results":[` +
	`{"policy":"ns-owner","result":"fail","severity":"high","source":"kyverno","message":"shop has no owner"},{"policy":"ns-quota","result":"pass","source":"kyverno"}]}`
const cprRoles = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"ClusterPolicyReport","metadata":{"name":"r-roles"},"results":[` +
	`{"policy":"no-wildcard","result":"error","source":"trivy","resources":[{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"ClusterRole","name":"admin-x"},{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"ClusterRole","name":"admin-y"}]}]}`

// a fake API server answering the paths given (anything else 404) and counting what was asked
func policyReportFake(t *testing.T, answers map[string]func(w http.ResponseWriter)) (*Service, *prServer) {
	t.Helper()
	ps := &prServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		ps.mu.Lock()
		ps.paths = append(ps.paths, r.URL.Path)
		ps.mu.Unlock()
		if answer, ok := answers[r.URL.Path]; ok {
			answer(w)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	dyn, err := dynamic.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs, dynamic: dyn})
	policyReportCaches.mu.Lock()
	policyReportCaches.m = map[string]*policyReportCache{}
	policyReportCaches.mu.Unlock()
	return s, ps
}

func reportList(kind string, items ...string) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"` + kind + `","metadata":{},"items":[` + strings.Join(items, ",") + `]}`))
	}
}

// result:kind/name/policy of each row, in the answer's order
func rowWords(res *PolicyReportResource) []string {
	out := []string{}
	for _, r := range res.Rows {
		out = append(out, r.Result+":"+r.Namespace+"/"+r.Kind+"/"+r.Name+"/"+r.Policy)
	}
	return out
}

// A result names every resource in its resources list: each one's drawer gets the row, named after itself, while the
// page's results keep one row per result (its first resource).
func TestPolicyReportsForResource_EveryResourceAResultNames(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		"/apis/wgpolicyk8s.io/v1alpha2/namespaces/shop/policyreports": reportList("PolicyReportList", prShopConfig),
	})
	ctx := context.Background()
	for _, c := range []struct {
		kind, name string
		want       []string
		totals     PolicyReportCounts
	}{
		{"ConfigMap", "cm-a", []string{"fail:shop/ConfigMap/cm-a/need-team"}, counts(0, 1, 0, 0, 0)},
		{"ConfigMap", "cm-b", []string{"fail:shop/ConfigMap/cm-b/need-team", "warn:shop/ConfigMap/cm-b/no-plain-secret"}, counts(0, 1, 1, 0, 0)},
		{"Secret", "s-1", []string{"warn:shop/Secret/s-1/no-plain-secret"}, counts(0, 0, 1, 0, 0)},
		{"Service", "web", []string{"pass:shop/Service/web/need-team"}, counts(1, 0, 0, 0, 0)},
		{"ConfigMap", "cm-c", []string{}, counts(0, 0, 0, 0, 0)},
	} {
		res, err := s.PolicyReportsForResource(ctx, "shop", c.kind, c.name, false)
		if err != nil {
			t.Fatal(err)
		}
		if got := rowWords(res); !reflect.DeepEqual(got, c.want) || res.Totals != c.totals {
			t.Errorf("%s/%s: rows %v totals %+v, want %v %+v", c.kind, c.name, got, res.Totals, c.want, c.totals)
		}
	}
	// none of a resource's rows is JSON null, and the answer carries no list of the other resources
	none, _ := s.PolicyReportsForResource(ctx, "shop", "ConfigMap", "cm-c", false)
	if b, _ := json.Marshal(none); !strings.Contains(string(b), `"rows":[]`) {
		t.Errorf("no rows: %s", b)
	}
	page, err := s.PolicyReportResults(ctx, PolicyReportFilter{Namespace: "shop", Results: []string{"fail", "warn", "pass"}})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range page.Rows {
		got = append(got, r.Result+":"+r.Kind+"/"+r.Name)
	}
	if want := []string{"fail:ConfigMap/cm-a", "warn:ConfigMap/cm-b", "pass:Service/web"}; !reflect.DeepEqual(got, want) || page.Total != 3 {
		t.Errorf("page rows %v (total %d), want one per result %v", got, page.Total, want)
	}
	var keys map[string]interface{}
	if b, _ := json.Marshal(page.Rows[0]); json.Unmarshal(b, &keys) != nil || keys["name"] != "cm-a" || keys["api_version"] != "v1" || len(keys) != 9 {
		t.Errorf("a page row names its first resource and nothing more: %s", b)
	}
}

// A cluster-scoped resource's rows come from the ClusterPolicyReports alone (its scope or its resources), read once a
// minute per identity unless forced.
func TestPolicyReportsForClusterResource(t *testing.T) {
	s, srv := policyReportFake(t, map[string]func(http.ResponseWriter){
		"/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports": reportList("ClusterPolicyReportList", cprShopNS, cprRoles),
	})
	ctx := context.Background()
	for _, c := range []struct {
		kind, name string
		want       []string
		totals     PolicyReportCounts
	}{
		{"Namespace", "shop", []string{"fail:/Namespace/shop/ns-owner", "pass:/Namespace/shop/ns-quota"}, counts(1, 1, 0, 0, 0)},
		{"ClusterRole", "admin-x", []string{"error:/ClusterRole/admin-x/no-wildcard"}, counts(0, 0, 0, 1, 0)},
		{"ClusterRole", "admin-y", []string{"error:/ClusterRole/admin-y/no-wildcard"}, counts(0, 0, 0, 1, 0)},
		{"Namespace", "other", []string{}, counts(0, 0, 0, 0, 0)},
	} {
		res, err := s.PolicyReportsForClusterResource(ctx, c.kind, c.name, false)
		if err != nil {
			t.Fatal(err)
		}
		if got := rowWords(res); !reflect.DeepEqual(got, c.want) || res.Totals != c.totals || res.Namespace != "" || res.Kind != c.kind || res.Name != c.name {
			t.Errorf("%s/%s: %+v rows %v, want %v %+v", c.kind, c.name, res, got, c.want, c.totals)
		}
	}
	if res, _ := s.PolicyReportsForClusterResource(ctx, "Namespace", "shop", false); res.Rows[0].Severity != "high" || res.Rows[0].Message != "shop has no owner" || res.Rows[0].Report != "r-ns-shop" {
		t.Errorf("row detail = %+v", res.Rows[0])
	}
	if n, ns := srv.count("/clusterpolicyreports"), srv.count("/policyreports"); n != 1 || ns != 0 {
		t.Fatalf("lists: %v — want the cluster reports once (the minute cache), no namespace's", srv.paths)
	}
	if _, err := s.PolicyReportsForClusterResource(ctx, "Namespace", "shop", true); err != nil || srv.count("/clusterpolicyreports") != 2 {
		t.Fatalf("a forced read goes to the cluster: %v %v", err, srv.paths)
	}
	other := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u2"})
	if _, err := s.PolicyReportsForClusterResource(other, "Namespace", "shop", false); err != nil || srv.count("/clusterpolicyreports") != 3 {
		t.Fatalf("another identity reads for itself: %v %v", err, srv.paths)
	}
	// the whole view's cache entry is not the cluster reports': the summary lists the namespaces' reports (404 here)
	if _, err := s.PolicyReportSummary(ctx, "", false); err == nil || srv.count("/v1alpha2/policyreports") != 1 {
		t.Fatalf("the summary was served the cluster reports: %v %v", err, srv.paths)
	}
}

// What the cluster refuses is the answer (the drawer says it), and a grant limited to namespaces is not given the
// cluster reports, as its summary leaves them out — without asking the cluster.
func TestPolicyReportsForClusterResource_Refused(t *testing.T) {
	s, srv := policyReportFake(t, map[string]func(http.ResponseWriter){
		"/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports": func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403,"message":"clusterpolicyreports.wgpolicyk8s.io is forbidden: User \"u1\" cannot list resource \"clusterpolicyreports\""}`))
		},
	})
	ctx := context.Background()
	res, err := s.PolicyReportsForClusterResource(ctx, "Namespace", "shop", false)
	if !apierrors.IsForbidden(err) || res != nil || !strings.Contains(err.Error(), `cannot list resource "clusterpolicyreports"`) {
		t.Fatalf("refused: %+v %v", res, err)
	}
	scoped := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"shop"}}})
	before := srv.count("/clusterpolicyreports")
	_, err = s.PolicyReportsForClusterResource(scoped, "Namespace", "shop", false)
	if !apierrors.IsForbidden(err) || !strings.Contains(err.Error(), "outside a grant limited to namespaces") || srv.count("/clusterpolicyreports") != before {
		t.Fatalf("scoped: %v, lists %v", err, srv.paths)
	}
}

// The resources after the first: kind and name needed, the report's namespace unless one is named.
func TestPolicyReportOthers(t *testing.T) {
	raw := []interface{}{
		map[string]interface{}{"kind": "ConfigMap", "name": "first"},
		map[string]interface{}{"apiVersion": "v1", "kind": "ConfigMap", "name": "b"},
		map[string]interface{}{"kind": "Secret", "name": "s", "namespace": "other"},
		map[string]interface{}{"kind": "ConfigMap"},
		"not an object",
	}
	want := []policyReportRef{{"shop", "ConfigMap", "b", "v1"}, {"other", "Secret", "s", ""}}
	if got := policyReportOthers(raw, "shop"); !reflect.DeepEqual(got, want) {
		t.Errorf("others = %v, want %v", got, want)
	}
	if got := policyReportOthers(raw[:1], "shop"); got != nil {
		t.Errorf("one resource: %v", got)
	}
	if got := policyReportOthers(nil, "shop"); got != nil {
		t.Errorf("no resources: %v", got)
	}
}

// A row named after a later resource of its result carries that resource's apiVersion, so a Kind two groups serve
// opens the object the row is about.
func TestPolicyReportKeep_TheMatchedResourcesAPIVersion(t *testing.T) {
	r := PolicyReportResult{Namespace: "shop", Kind: "Widget", Name: "w1", APIVersion: "a.example.io/v1", Result: "fail",
		also: []policyReportRef{{"shop", "Widget", "w2", "b.example.io/v1"}}}
	var out PolicyReportResource
	out.keep([]PolicyReportResult{r}, func(ref policyReportRef) bool { return ref.Name == "w2" })
	if len(out.Rows) != 1 || out.Rows[0].Name != "w2" || out.Rows[0].APIVersion != "b.example.io/v1" {
		t.Fatalf("rows = %+v, want w2 of b.example.io/v1", out.Rows)
	}
}
