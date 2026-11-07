package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

var allPolicyResults = []string{"pass", "fail", "warn", "error", "skip"}

func namespaceViewFake(t *testing.T) (*Service, *prServer) {
	t.Helper()
	return policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList", prOwnRow),
		prClusterReports:   reportList("ClusterPolicyReportList", cprNamesObjects, cprScopeNamesObject),
	})
}

func resultWords(rows []PolicyReportResult) []string {
	out := []string{}
	for _, r := range rows {
		out = append(out, r.Result+":"+r.Namespace+"/"+r.Kind+"/"+r.Name+"/"+r.Policy)
	}
	sort.Strings(out)
	return out
}

// clusterReportsErrorOf reads the answer as a client does.
func clusterReportsErrorOf(t *testing.T, answer interface{}) string {
	t.Helper()
	raw, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]interface{}
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	text, _ := keys["cluster_reports_error"].(string)
	return text
}

// The page and the AI tool asked for a namespace count what its objects' drawers list: the rows a ClusterPolicyReport
// holds about an object of that namespace, each named after that object, and none about another namespace.
func TestPolicyReportResults_ANamespaceHoldsTheClusterReportsNamingItsObjects(t *testing.T) {
	s, _ := namespaceViewFake(t)
	ctx := context.Background()
	res, err := s.PolicyReportResults(ctx, PolicyReportFilter{Namespace: "shop", Results: allPolicyResults})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"error:shop/ConfigMap/cm-a/cluster-scope",
		"fail:shop/ConfigMap/cm-a/cluster-first",
		"fail:shop/ConfigMap/cm-a/own-report",
		"warn:shop/ConfigMap/cm-a/cluster-later",
	}
	if got := resultWords(res.Rows); !reflect.DeepEqual(got, want) || res.Total != len(want) {
		t.Errorf("rows %v total %d, want %v", got, res.Total, want)
	}
	drawer, err := s.PolicyReportsForResource(ctx, "shop", "ConfigMap", "cm-a", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if got, words := resultWords(drawer.Rows), resultWords(res.Rows); !reflect.DeepEqual(got, words) {
		t.Errorf("the drawer lists %v and the page %v", got, words)
	}
	if text := clusterReportsErrorOf(t, res); text != "" {
		t.Errorf("read and yet named as not read: %q", text)
	}
}

// The cards, the tabs and the number of reports say the same as the rows.
func TestPolicyReportSummary_ANamespaceCountsTheClusterReportsNamingItsObjects(t *testing.T) {
	s, _ := namespaceViewFake(t)
	sum, err := s.PolicyReportSummary(context.Background(), "shop", false)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Totals != counts(0, 2, 1, 1, 0) || sum.Reports != 3 {
		t.Errorf("totals %+v reports %d", sum.Totals, sum.Reports)
	}
	if len(sum.Namespaces) != 1 || sum.Namespaces[0].Namespace != "shop" || sum.Namespaces[0].Policies != 4 {
		t.Errorf("namespaces %+v", sum.Namespaces)
	}
	policies := []string{}
	for _, p := range sum.Policies {
		policies = append(policies, p.Policy)
		if !reflect.DeepEqual(p.Namespaces, []string{"shop"}) {
			t.Errorf("%s in %v", p.Policy, p.Namespaces)
		}
	}
	sort.Strings(policies)
	if want := []string{"cluster-first", "cluster-later", "cluster-scope", "own-report"}; !reflect.DeepEqual(policies, want) {
		t.Errorf("policies %v, want %v", policies, want)
	}
}

// A later resource names the namespace asked: the row reads as that object wherever the first one is.
func TestPolicyReportResults_ARowNamedAfterTheObjectOfTheNamespaceAsked(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList"),
		prClusterReports: reportList("ClusterPolicyReportList", `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"ClusterPolicyReport","metadata":{"name":"r"},"results":[`+
			`{"policy":"two-namespaces","result":"fail","resources":[{"apiVersion":"v1","kind":"Pod","name":"p-1","namespace":"other"},{"apiVersion":"v1","kind":"Service","name":"s-1","namespace":"shop"}]}]}`),
	})
	res, err := s.PolicyReportResults(context.Background(), PolicyReportFilter{Namespace: "shop", Kind: "Service"})
	if err != nil {
		t.Fatal(err)
	}
	if got := resultWords(res.Rows); !reflect.DeepEqual(got, []string{"fail:shop/Service/s-1/two-namespaces"}) {
		t.Errorf("rows %v", got)
	}
}

// The view of the whole cluster counted the cluster reports already, once each.
func TestPolicyReportResults_TheWholeClusterCountsEachRowOnce(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		"/apis/wgpolicyk8s.io/v1alpha2/policyreports": reportList("PolicyReportList", prOwnRow),
		prClusterReports: reportList("ClusterPolicyReportList", cprNamesObjects, cprScopeNamesObject),
	})
	res, err := s.PolicyReportResults(context.Background(), PolicyReportFilter{Results: allPolicyResults})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 6 {
		t.Errorf("total %d: %v", res.Total, resultWords(res.Rows))
	}
}

// What could not be read is said, on the rows and the cards alike, whichever view it is; "none" would be an answer nobody read.
func TestPolicyReports_ClusterReportsRefusedAreNamedInEveryView(t *testing.T) {
	for _, namespace := range []string{"shop", ""} {
		s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
			prNamespaceReports: reportList("PolicyReportList", prOwnRow),
			"/apis/wgpolicyk8s.io/v1alpha2/policyreports": reportList("PolicyReportList", prOwnRow),
			prClusterReports: clusterReportsRefused,
		})
		ctx := context.Background()
		res, err := s.PolicyReportResults(ctx, PolicyReportFilter{Namespace: namespace, Results: allPolicyResults})
		if err != nil {
			t.Fatal(err)
		}
		sum, err := s.PolicyReportSummary(ctx, namespace, false)
		if err != nil {
			t.Fatal(err)
		}
		if got := resultWords(res.Rows); !reflect.DeepEqual(got, []string{"fail:shop/ConfigMap/cm-a/own-report"}) || sum.Totals != counts(0, 1, 0, 0, 0) {
			t.Errorf("namespace %q: rows %v totals %+v", namespace, got, sum.Totals)
		}
		for name, answer := range map[string]interface{}{"results": res, "summary": sum} {
			if text := clusterReportsErrorOf(t, answer); !strings.Contains(text, `cannot list resource "clusterpolicyreports"`) {
				t.Errorf("namespace %q %s: cluster reports error = %q", namespace, name, text)
			}
		}
	}
}

// A grant limited to namespaces is not given the cluster reports, without asking the cluster, and is told.
func TestPolicyReports_AGrantLimitedToNamespacesIsToldInEveryView(t *testing.T) {
	for _, namespace := range []string{"shop", ""} {
		s, srv := namespaceViewFake(t)
		scoped := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"shop"}}})
		res, err := s.PolicyReportResults(scoped, PolicyReportFilter{Namespace: namespace, Results: allPolicyResults})
		if err != nil {
			t.Fatal(err)
		}
		sum, err := s.PolicyReportSummary(scoped, namespace, false)
		if err != nil {
			t.Fatal(err)
		}
		if got := resultWords(res.Rows); !reflect.DeepEqual(got, []string{"fail:shop/ConfigMap/cm-a/own-report"}) || !res.Scoped || !sum.Scoped {
			t.Errorf("namespace %q: rows %v scoped %v %v", namespace, got, res.Scoped, sum.Scoped)
		}
		for name, answer := range map[string]interface{}{"results": res, "summary": sum} {
			if text := clusterReportsErrorOf(t, answer); !strings.Contains(text, "outside a grant limited to namespaces") {
				t.Errorf("namespace %q %s: cluster reports error = %q", namespace, name, text)
			}
		}
		if n := srv.count("/clusterpolicyreports"); n != 0 {
			t.Errorf("namespace %q: the cluster reports were asked for %d times", namespace, n)
		}
	}
}

// A cluster serving no ClusterPolicyReport kind has nothing unread to name.
func TestPolicyReports_NoClusterReportKindIsNoNotice(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList", prOwnRow),
	})
	res, err := s.PolicyReportResults(context.Background(), PolicyReportFilter{Namespace: "shop", Results: allPolicyResults})
	if err != nil {
		t.Fatal(err)
	}
	if got := resultWords(res.Rows); !reflect.DeepEqual(got, []string{"fail:shop/ConfigMap/cm-a/own-report"}) || clusterReportsErrorOf(t, res) != "" {
		t.Errorf("rows %v, error %q", got, clusterReportsErrorOf(t, res))
	}
}

// A cut read of the cluster reports makes the namespace's view a cut one too.
func TestPolicyReports_ClusterReportsCutCutTheNamespaceView(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList", prOwnRow),
	})
	c := policyReportCacheFor("default")
	c.mu.Lock()
	c.sets["*cluster|as:"] = policyReportSet{truncated: true, reports: policyReportMaxReports, at: time.Now()}
	c.mu.Unlock()
	res, err := s.PolicyReportResults(context.Background(), PolicyReportFilter{Namespace: "shop"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Truncated {
		t.Errorf("truncated false: %+v", res)
	}
}
