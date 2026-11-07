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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	fakediscovery "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
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
		res, err := s.PolicyReportsForResource(ctx, "shop", c.kind, c.name, "", false)
		if err != nil {
			t.Fatal(err)
		}
		if got := rowWords(res); !reflect.DeepEqual(got, c.want) || res.Totals != c.totals {
			t.Errorf("%s/%s: rows %v totals %+v, want %v %+v", c.kind, c.name, got, res.Totals, c.want, c.totals)
		}
	}
	// none of a resource's rows is JSON null, and the answer carries no list of the other resources
	none, _ := s.PolicyReportsForResource(ctx, "shop", "ConfigMap", "cm-c", "", false)
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
		res, err := s.PolicyReportsForClusterResource(ctx, c.kind, c.name, "", false)
		if err != nil {
			t.Fatal(err)
		}
		if got := rowWords(res); !reflect.DeepEqual(got, c.want) || res.Totals != c.totals || res.Namespace != "" || res.Kind != c.kind || res.Name != c.name {
			t.Errorf("%s/%s: %+v rows %v, want %v %+v", c.kind, c.name, res, got, c.want, c.totals)
		}
	}
	if res, _ := s.PolicyReportsForClusterResource(ctx, "Namespace", "shop", "", false); res.Rows[0].Severity != "high" || res.Rows[0].Message != "shop has no owner" || res.Rows[0].Report != "r-ns-shop" {
		t.Errorf("row detail = %+v", res.Rows[0])
	}
	if n, ns := srv.count("/clusterpolicyreports"), srv.count("/policyreports"); n != 1 || ns != 0 {
		t.Fatalf("lists: %v — want the cluster reports once (the minute cache), no namespace's", srv.paths)
	}
	if _, err := s.PolicyReportsForClusterResource(ctx, "Namespace", "shop", "", true); err != nil || srv.count("/clusterpolicyreports") != 2 {
		t.Fatalf("a forced read goes to the cluster: %v %v", err, srv.paths)
	}
	other := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u2"})
	if _, err := s.PolicyReportsForClusterResource(other, "Namespace", "shop", "", false); err != nil || srv.count("/clusterpolicyreports") != 3 {
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
	res, err := s.PolicyReportsForClusterResource(ctx, "Namespace", "shop", "", false)
	if !apierrors.IsForbidden(err) || res != nil || !strings.Contains(err.Error(), `cannot list resource "clusterpolicyreports"`) {
		t.Fatalf("refused: %+v %v", res, err)
	}
	scoped := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"shop"}}})
	before := srv.count("/clusterpolicyreports")
	_, err = s.PolicyReportsForClusterResource(scoped, "Namespace", "shop", "", false)
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

// A result may pick its resources by label (resourceSelector), and a report its scope (scopeSelector): each object whose
// labels match gets the row in its drawer, named after itself, in the report's namespace only.
const prSelector = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"PolicyReport","metadata":{"name":"r-sel","namespace":"shop"},"results":[` +
	`{"policy":"need-limits","result":"fail","source":"kube-bench","message":"web pods","resourceSelector":{"matchLabels":{"app":"web"}}},` +
	`{"policy":"no-latest","result":"warn","source":"kube-bench","resourceSelector":{"matchExpressions":[{"key":"tier","operator":"In","values":["front","back"]}]}},` +
	`{"policy":"named-one","result":"fail","source":"kube-bench","resources":[{"apiVersion":"v1","kind":"ConfigMap","name":"cm-other","namespace":"shop"}]}]}`
const prScopeSelector = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"PolicyReport","metadata":{"name":"r-scope-sel","namespace":"shop"},"scopeSelector":{"matchLabels":{"app":"web"}},"results":[` +
	`{"policy":"whole-scope","result":"error","source":"kube-bench"}]}`

func labelledObject(kind, name string, labels string) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"` + kind + `","metadata":{"name":"` + name + `","namespace":"shop","labels":` + labels + `}}`))
	}
}

func withPolicyDiscovery(s *Service) {
	b := s.defaultBundle.Load()
	disc := fake.NewSimpleClientset().Discovery().(*fakediscovery.FakeDiscovery)
	disc.Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "configmaps", SingularName: "configmap", Kind: "ConfigMap", Namespaced: true}, {Name: "pods", SingularName: "pod", Kind: "Pod", Namespaced: true}}},
		{GroupVersion: "apps/v1", APIResources: []metav1.APIResource{{Name: "deployments", SingularName: "deployment", Kind: "Deployment", Namespaced: true}}},
	}
	s.defaultBundle.Store(&clientBundle{clientset: b.clientset, dynamic: b.dynamic, discovery: disc})
}

func TestPolicyReportsForResource_ResultsPickedByLabel(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		"/apis/wgpolicyk8s.io/v1alpha2/namespaces/shop/policyreports": reportList("PolicyReportList", prSelector, prScopeSelector),
		"/api/v1/namespaces/shop/configmaps/cm-web":                   labelledObject("ConfigMap", "cm-web", `{"app":"web"}`),
		"/api/v1/namespaces/shop/configmaps/cm-front":                 labelledObject("ConfigMap", "cm-front", `{"tier":"front"}`),
		"/api/v1/namespaces/shop/configmaps/cm-plain":                 labelledObject("ConfigMap", "cm-plain", `{"team":"x"}`),
		"/api/v1/namespaces/shop/configmaps/cm-other":                 labelledObject("ConfigMap", "cm-other", `{"team":"x"}`),
	})
	withPolicyDiscovery(s)
	ctx := context.Background()
	for _, c := range []struct {
		name string
		want []string
	}{
		{"cm-web", []string{"fail:shop/ConfigMap/cm-web/need-limits", "error:shop/ConfigMap/cm-web/whole-scope"}},
		{"cm-front", []string{"warn:shop/ConfigMap/cm-front/no-latest"}},
		{"cm-plain", []string{}},
		{"cm-other", []string{"fail:shop/ConfigMap/cm-other/named-one"}},
	} {
		res, err := s.PolicyReportsForResource(ctx, "shop", "ConfigMap", c.name, "", false)
		if err != nil {
			t.Fatal(err)
		}
		if got := rowWords(res); !reflect.DeepEqual(got, c.want) || res.SelectorError != "" {
			t.Errorf("%s: rows %v (selector error %q), want %v", c.name, got, res.SelectorError, c.want)
		}
	}
	// the page keeps one row per result, saying what it picks
	page, err := s.PolicyReportResults(ctx, PolicyReportFilter{Namespace: "shop", Results: []string{"fail", "warn", "error"}})
	if err != nil {
		t.Fatal(err)
	}
	selectors := map[string]string{}
	for _, r := range page.Rows {
		selectors[r.Policy] = r.Selector
	}
	if want := map[string]string{"need-limits": "app=web", "no-latest": "tier in (back,front)", "whole-scope": "app=web", "named-one": ""}; !reflect.DeepEqual(selectors, want) {
		t.Errorf("page selectors %v, want %v", selectors, want)
	}
	// what the page shows of such a row can be searched
	found, err := s.PolicyReportResults(ctx, PolicyReportFilter{Namespace: "shop", Search: "tier in"})
	if err != nil {
		t.Fatal(err)
	}
	if len(found.Rows) != 1 || found.Rows[0].Policy != "no-latest" {
		t.Errorf("search by the selector: %+v", found.Rows)
	}
}

// A workload's section takes the label-picked rows of its pods too, each named after its pod.
func TestPolicyReportsForResource_WorkloadPodsPickedByLabel(t *testing.T) {
	pod := func(name, app string) string {
		return `{"metadata":{"name":"` + name + `","namespace":"shop","labels":{"app":"` + app + `"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"web-1","controller":true}]},"spec":{"containers":[{"name":"c"}]}}`
	}
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		"/apis/wgpolicyk8s.io/v1alpha2/namespaces/shop/policyreports": reportList("PolicyReportList", `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"PolicyReport","metadata":{"name":"r-sel","namespace":"shop"},"results":[{"policy":"need-limits","result":"fail","resourceSelector":{"matchLabels":{"app":"canary"}}}]}`),
		"/apis/apps/v1/namespaces/shop/deployments/web":               labelledObject("Deployment", "web", `{"app":"web"}`),
		"/apis/apps/v1/namespaces/shop/replicasets": func(w http.ResponseWriter) {
			_, _ = w.Write([]byte(`{"apiVersion":"apps/v1","kind":"ReplicaSetList","metadata":{},"items":[{"metadata":{"name":"web-1","namespace":"shop","ownerReferences":[{"apiVersion":"apps/v1","kind":"Deployment","name":"web","controller":true}]},"spec":{"selector":{}}}]}`))
		},
		"/apis/batch/v1/namespaces/shop/jobs": func(w http.ResponseWriter) {
			_, _ = w.Write([]byte(`{"apiVersion":"batch/v1","kind":"JobList","metadata":{},"items":[]}`))
		},
		"/api/v1/namespaces/shop/pods": func(w http.ResponseWriter) {
			_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"PodList","metadata":{},"items":[` + pod("web-a", "canary") + `,` + pod("web-b", "web") + `]}`))
		},
	})
	withPolicyDiscovery(s)
	res, err := s.PolicyReportsForResource(context.Background(), "shop", "Deployment", "web", "apps/v1", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowWords(res); !reflect.DeepEqual(got, []string{"fail:shop/Pod/web-a/need-limits"}) || res.Totals != counts(0, 1, 0, 0, 0) {
		t.Errorf("rows %v totals %+v, want web-a's row", got, res.Totals)
	}
}

// Without leave to read the object its labels are not known: the rows naming it stay, and the answer says the
// label-picked results could not be held to it; a report without selectors never asks for the object.
func TestPolicyReportsForResource_ObjectLabelsUnread(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		"/apis/wgpolicyk8s.io/v1alpha2/namespaces/shop/policyreports": reportList("PolicyReportList", prSelector),
		"/api/v1/namespaces/shop/configmaps/cm-other": func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403,"message":"configmaps is forbidden"}`))
		},
	})
	withPolicyDiscovery(s)
	res, err := s.PolicyReportsForResource(context.Background(), "shop", "ConfigMap", "cm-other", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowWords(res); !reflect.DeepEqual(got, []string{"fail:shop/ConfigMap/cm-other/named-one"}) || !strings.Contains(res.SelectorError, "configmaps is forbidden") {
		t.Errorf("rows %v, selector error %q", got, res.SelectorError)
	}

	plain, ps := policyReportFake(t, map[string]func(http.ResponseWriter){
		"/apis/wgpolicyk8s.io/v1alpha2/namespaces/shop/policyreports": reportList("PolicyReportList", prShopConfig),
	})
	withPolicyDiscovery(plain)
	if _, err := plain.PolicyReportsForResource(context.Background(), "shop", "ConfigMap", "cm-a", "", false); err != nil {
		t.Fatal(err)
	}
	for _, p := range ps.paths {
		if strings.Contains(p, "/configmaps/") {
			t.Errorf("asked for the object without a selector in the reports: %s", p)
		}
	}
}

// A cluster-scoped object's section takes the label-picked results of the ClusterPolicyReports.
func TestPolicyReportsForClusterResource_ResultsPickedByLabel(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		"/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports": reportList("ClusterPolicyReportList", `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"ClusterPolicyReport","metadata":{"name":"r"},"results":[{"policy":"nodes-need-zone","result":"fail","resourceSelector":{"matchLabels":{"pool":"gpu"}}}]}`),
		"/api/v1/nodes/n1": func(w http.ResponseWriter) {
			_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"Node","metadata":{"name":"n1","labels":{"pool":"gpu"}}}`))
		},
	})
	b := s.defaultBundle.Load()
	disc := fake.NewSimpleClientset().Discovery().(*fakediscovery.FakeDiscovery)
	disc.Resources = []*metav1.APIResourceList{{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "nodes", SingularName: "node", Kind: "Node", Namespaced: false}}}}
	s.defaultBundle.Store(&clientBundle{clientset: b.clientset, dynamic: b.dynamic, discovery: disc})
	res, err := s.PolicyReportsForClusterResource(context.Background(), "Node", "n1", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowWords(res); !reflect.DeepEqual(got, []string{"fail:/Node/n1/nodes-need-zone"}) {
		t.Errorf("rows %v", got)
	}
}
