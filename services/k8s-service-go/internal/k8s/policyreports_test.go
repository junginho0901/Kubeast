package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// Reports as Kyverno 1.19 writes them, trimmed: three PolicyReports (two in
// apps, one in kube-system) and one ClusterPolicyReport.
const prWeb1 = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"PolicyReport","metadata":{"name":"r-web-1","namespace":"apps"},"scope":{"apiVersion":"v1","kind":"Pod","name":"web-1","namespace":"apps"},"summary":{"pass":1,"fail":1,"warn":0,"error":0,"skip":0},"results":[{"policy":"require-labels","rule":"check-labels","result":"fail","severity":"medium","category":"Best Practices","source":"kyverno","message":"Pod web-1 must have the label app.kubernetes.io/name","timestamp":{"seconds":1791861000,"nanos":0}},{"policy":"disallow-latest-tag","result":"pass","severity":"medium","category":"Best Practices","source":"kyverno","timestamp":{"seconds":1791861000,"nanos":0}}]}`
const prWebDeploy = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"PolicyReport","metadata":{"name":"r-web","namespace":"apps"},"scope":{"apiVersion":"apps/v1","kind":"Deployment","name":"web","namespace":"apps"},"results":[{"policy":"require-labels","rule":"autogen-check-labels","result":"fail","severity":"medium","category":"Best Practices","source":"kyverno","message":"Deployment web must have the label","resources":[{"apiVersion":"apps/v1","kind":"Deployment","name":"web","namespace":"apps"}]}]}`
const prKubeProxy = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"PolicyReport","metadata":{"name":"r-kube-proxy","namespace":"kube-system"},"scope":{"apiVersion":"v1","kind":"Pod","name":"kube-proxy-x","namespace":"kube-system"},"results":[{"policy":"require-labels","result":"fail","severity":"medium","category":"Best Practices","source":"kyverno"},{"policy":"custom-check","result":"warn","severity":"low","category":"Other","source":"trivy","message":"warned"},{"policy":"empty-result","result":""}]}`
const cprApps = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"ClusterPolicyReport","metadata":{"name":"r-ns-apps"},"scope":{"apiVersion":"v1","kind":"Namespace","name":"apps"},"results":[{"policy":"ns-policy","result":"pass","source":"kyverno"}]}`

type prServer struct {
	mu    sync.Mutex
	paths []string
}

func (p *prServer) count(sub string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, x := range p.paths {
		if strings.Contains(x, sub) {
			n++
		}
	}
	return n
}

func newPolicyReportService(t *testing.T) (*Service, *prServer) {
	t.Helper()
	ps := &prServer{}
	list := func(items ...string) string {
		return `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"PolicyReportList","metadata":{},"items":[` + strings.Join(items, ",") + `]}`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		p := r.URL.Path
		ps.mu.Lock()
		ps.paths = append(ps.paths, p)
		ps.mu.Unlock()
		switch p {
		case "/apis/wgpolicyk8s.io/v1alpha2/namespaces/apps/policyreports":
			_, _ = w.Write([]byte(list(prWeb1, prWebDeploy)))
		case "/apis/wgpolicyk8s.io/v1alpha2/namespaces/kube-system/policyreports":
			_, _ = w.Write([]byte(list(prKubeProxy)))
		case "/apis/wgpolicyk8s.io/v1alpha2/policyreports":
			_, _ = w.Write([]byte(list(prWeb1, prWebDeploy, prKubeProxy)))
		case "/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports":
			_, _ = w.Write([]byte(`{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"ClusterPolicyReportList","metadata":{},"items":[` + cprApps + `]}`))
		case "/api/v1/namespaces/apps/pods":
			_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"web-1","namespace":"apps","ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"web-abc","controller":true,"uid":"1"}]},"spec":{"containers":[{"name":"app"}]},"status":{"phase":"Running"}},{"metadata":{"name":"bare-pod","namespace":"apps"},"spec":{"containers":[{"name":"app"}]},"status":{"phase":"Running"}}]}`))
		case "/apis/apps/v1/namespaces/apps/replicasets":
			_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"web-abc","namespace":"apps","ownerReferences":[{"apiVersion":"apps/v1","kind":"Deployment","name":"web","controller":true,"uid":"2"}]}}]}`))
		case "/apis/batch/v1/namespaces/apps/jobs":
			_, _ = w.Write([]byte(`{"items":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		}
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

func counts(pass, fail, warn, errs, skip int) PolicyReportCounts {
	return PolicyReportCounts{Pass: pass, Fail: fail, Warn: warn, Error: errs, Skip: skip}
}

func TestPolicyReportSummary_WholeCluster(t *testing.T) {
	s, srv := newPolicyReportService(t)
	ctx := context.Background()
	sum, err := s.PolicyReportSummary(ctx, "", false)
	if err != nil {
		t.Fatal(err)
	}
	// Rows without a result are dropped; cluster reports count in a whole-cluster view.
	if sum.Reports != 4 || sum.Truncated || sum.Scoped || sum.Totals != counts(2, 3, 1, 0, 0) {
		t.Fatalf("summary header = %+v", sum)
	}
	var policies []string
	for _, p := range sum.Policies {
		policies = append(policies, p.Policy)
	}
	if want := []string{"require-labels", "custom-check", "disallow-latest-tag", "ns-policy"}; !reflect.DeepEqual(policies, want) {
		t.Fatalf("policies = %v, want %v (most failures first, then warns, then name)", policies, want)
	}
	rl := sum.Policies[0]
	if rl.PolicyReportCounts != counts(0, 3, 0, 0, 0) || rl.Category != "Best Practices" || rl.Severity != "medium" || rl.Source != "kyverno" || !reflect.DeepEqual(rl.Namespaces, []string{"apps", "kube-system"}) {
		t.Fatalf("require-labels row = %+v", rl)
	}
	if ns := sum.Policies[3].Namespaces; len(ns) != 0 {
		t.Fatalf("a cluster policy lists no namespaces: %v", ns)
	}
	var namespaces []string
	for _, n := range sum.Namespaces {
		namespaces = append(namespaces, n.Namespace)
	}
	if want := []string{"apps", "kube-system", ""}; !reflect.DeepEqual(namespaces, want) {
		t.Fatalf("namespaces = %v, want %v", namespaces, want)
	}
	if apps := sum.Namespaces[0]; apps.PolicyReportCounts != counts(1, 2, 0, 0, 0) || apps.Policies != 2 {
		t.Fatalf("apps row = %+v", apps)
	}
	if srv.count("/policyreports") != 1 || srv.count("/clusterpolicyreports") != 1 {
		t.Fatalf("list calls = %v", srv.paths)
	}

	// One namespace: no cluster reports, only that namespace's list.
	one, err := s.PolicyReportSummary(ctx, "kube-system", false)
	if err != nil {
		t.Fatal(err)
	}
	if one.Reports != 1 || one.Totals != counts(0, 1, 1, 0, 0) || len(one.Namespaces) != 1 || one.Namespaces[0].Namespace != "kube-system" {
		t.Fatalf("kube-system summary = %+v", one)
	}
	if srv.count("/namespaces/kube-system/policyreports") != 1 || srv.count("/clusterpolicyreports") != 1 {
		t.Fatalf("list calls after the namespace read = %v", srv.paths)
	}
}

func TestPolicyReportResults_FilterSortAndCap(t *testing.T) {
	s, _ := newPolicyReportService(t)
	ctx := context.Background()
	res, err := s.PolicyReportResults(ctx, PolicyReportFilter{})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range res.Rows {
		got = append(got, r.Result+":"+r.Namespace+"/"+r.Kind+"/"+r.Name+"/"+r.Policy)
	}
	want := []string{"fail:apps/Deployment/web/require-labels", "fail:apps/Pod/web-1/require-labels", "fail:kube-system/Pod/kube-proxy-x/require-labels", "warn:kube-system/Pod/kube-proxy-x/custom-check"}
	if !reflect.DeepEqual(got, want) || res.Total != 4 || res.Truncated {
		t.Fatalf("default rows = %v (total %d truncated %v), want %v", got, res.Total, res.Truncated, want)
	}
	if res.Rows[1].Timestamp != "2026-10-13T03:10:00Z" || res.Rows[1].Message == "" || res.Rows[1].Report != "r-web-1" {
		t.Fatalf("row detail = %+v", res.Rows[1])
	}
	cases := []struct {
		name string
		f    PolicyReportFilter
		want int
	}{
		{"search web", PolicyReportFilter{Search: "WEB"}, 2},
		{"policy", PolicyReportFilter{Policy: "custom-check"}, 1},
		{"kind", PolicyReportFilter{Kind: "deployment"}, 1},
		{"severity low", PolicyReportFilter{Severities: []string{"low"}}, 1},
		{"pass only", PolicyReportFilter{Results: []string{"pass"}}, 2},
		{"namespace", PolicyReportFilter{Namespace: "apps"}, 2},
		{"all results", PolicyReportFilter{Results: []string{"pass", "fail", "warn", "error", "skip"}}, 6},
	}
	for _, c := range cases {
		r, err := s.PolicyReportResults(ctx, c.f)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if r.Total != c.want || len(r.Rows) != c.want {
			t.Errorf("%s: total %d rows %d, want %d", c.name, r.Total, len(r.Rows), c.want)
		}
	}
	capped, err := s.PolicyReportResults(ctx, PolicyReportFilter{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if capped.Total != 4 || len(capped.Rows) != 1 || !capped.Truncated || capped.Rows[0].Kind != "Deployment" {
		t.Fatalf("capped = %+v", capped)
	}
}

// A namespace-scoped grant reads its namespaces one by one (never the
// cluster-wide list it may not have), sees no cluster reports, and is refused
// a namespace outside the grant.
func TestPolicyReports_NamespaceScope(t *testing.T) {
	s, srv := newPolicyReportService(t)
	ctx := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"apps"}}})
	sum, err := s.PolicyReportSummary(ctx, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !sum.Scoped || sum.Reports != 2 || sum.Totals != counts(1, 2, 0, 0, 0) || len(sum.Namespaces) != 1 || sum.Namespaces[0].Namespace != "apps" {
		t.Fatalf("scoped summary = %+v", sum)
	}
	if srv.count("/namespaces/apps/policyreports") != 1 || srv.count("/v1alpha2/policyreports") != 0 || srv.count("/clusterpolicyreports") != 0 {
		t.Fatalf("scoped list calls = %v", srv.paths)
	}
	if _, err := s.PolicyReportSummary(ctx, "kube-system", false); !apierrors.IsForbidden(err) {
		t.Fatalf("outside the grant: err = %v, want forbidden", err)
	}
}

func TestPolicyReportsForResource_WorkloadIncludesItsPods(t *testing.T) {
	s, _ := newPolicyReportService(t)
	ctx := context.Background()
	res, err := s.PolicyReportsForResource(ctx, "apps", "Deployment", "web", false)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range res.Rows {
		got = append(got, r.Result+":"+r.Kind+"/"+r.Name+"/"+r.Policy)
	}
	want := []string{"fail:Deployment/web/require-labels", "fail:Pod/web-1/require-labels", "pass:Pod/web-1/disallow-latest-tag"}
	if !reflect.DeepEqual(got, want) || res.Totals != counts(1, 2, 0, 0, 0) {
		t.Fatalf("rows = %v totals %+v, want %v", got, res.Totals, want)
	}
	// A pod of its own: only its rows, no owner lookup.
	pod, err := s.PolicyReportsForResource(ctx, "apps", "Pod", "web-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(pod.Rows) != 2 || pod.Totals != counts(1, 1, 0, 0, 0) {
		t.Fatalf("pod rows = %+v", pod)
	}
	none, err := s.PolicyReportsForResource(ctx, "apps", "Pod", "bare-pod", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(none.Rows) != 0 {
		t.Fatalf("bare-pod has no report: %+v", none.Rows)
	}
}

// Answers are kept a minute per identity: the same identity reads once, another reads for itself.
func TestPolicyReports_CachePerIdentity(t *testing.T) {
	s, srv := newPolicyReportService(t)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if _, err := s.PolicyReportSummary(ctx, "apps", false); err != nil {
			t.Fatal(err)
		}
	}
	if n := srv.count("/namespaces/apps/policyreports"); n != 1 {
		t.Fatalf("same identity listed %d times, want 1", n)
	}
	other := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u2"})
	if _, err := s.PolicyReportResults(other, PolicyReportFilter{Namespace: "apps"}); err != nil {
		t.Fatal(err)
	}
	if n := srv.count("/namespaces/apps/policyreports"); n != 2 {
		t.Fatalf("another identity must read for itself: %d lists", n)
	}
	// A forced read (the page's refresh) goes to the cluster even inside the minute, and refreshes the cache.
	if _, err := s.PolicyReportSummary(ctx, "apps", true); err != nil {
		t.Fatal(err)
	}
	if n := srv.count("/namespaces/apps/policyreports"); n != 3 {
		t.Fatalf("force must read again: %d lists", n)
	}
	if _, err := s.PolicyReportResults(ctx, PolicyReportFilter{Namespace: "apps"}); err != nil {
		t.Fatal(err)
	}
	if n := srv.count("/namespaces/apps/policyreports"); n != 3 {
		t.Fatalf("after a forced read the cache serves again: %d lists", n)
	}
}

func TestPolicyReportsFeatureEnabled(t *testing.T) {
	for v, want := range map[string]bool{"": true, "true": true, "false": false, "0": false, "x": true} {
		t.Setenv("POLICY_REPORTS_ENABLED", v)
		if got := PolicyReportsFeatureEnabled(); got != want {
			t.Errorf("POLICY_REPORTS_ENABLED=%q: %v, want %v", v, got, want)
		}
	}
}
