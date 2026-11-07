package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const (
	prNamespaceReports = "/apis/wgpolicyk8s.io/v1alpha2/namespaces/shop/policyreports"
	prClusterReports   = "/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports"
)

// Cluster reports about objects of a namespace: as a result's first resource, a later one and a report's scope, one
// about the same name in another namespace, and a Namespace the namespaced object's drawer has nothing to do with.
const cprNamesObjects = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"ClusterPolicyReport","metadata":{"name":"r-cluster"},"results":[` +
	`{"policy":"cluster-first","result":"fail","source":"kube-bench","message":"cm-a in shop","resources":[{"apiVersion":"v1","kind":"ConfigMap","name":"cm-a","namespace":"shop"}]},` +
	`{"policy":"cluster-later","result":"warn","source":"kube-bench","resources":[{"apiVersion":"v1","kind":"Namespace","name":"shop"},{"apiVersion":"v1","kind":"ConfigMap","name":"cm-a","namespace":"shop"}]},` +
	`{"policy":"cluster-elsewhere","result":"fail","source":"kube-bench","resources":[{"apiVersion":"v1","kind":"ConfigMap","name":"cm-a","namespace":"other"}]},` +
	`{"policy":"cluster-namespace","result":"fail","source":"kube-bench","resources":[{"apiVersion":"v1","kind":"Namespace","name":"cm-a"}]}]}`
const cprScopeNamesObject = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"ClusterPolicyReport","metadata":{"name":"r-scope"},"scope":{"apiVersion":"v1","kind":"ConfigMap","name":"cm-a","namespace":"shop"},"results":[` +
	`{"policy":"cluster-scope","result":"error","source":"kube-bench"}]}`
const prOwnRow = `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"PolicyReport","metadata":{"name":"r-own","namespace":"shop"},"results":[` +
	`{"policy":"own-report","result":"fail","source":"kyverno","resources":[{"apiVersion":"v1","kind":"ConfigMap","name":"cm-a","namespace":"shop"}]}]}`

func clusterReportsRefused(w http.ResponseWriter) {
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403,"message":"clusterpolicyreports.wgpolicyk8s.io is forbidden: User \"u1\" cannot list resource \"clusterpolicyreports\""}`))
}

// A ClusterPolicyReport may name an object of a namespace: its drawer has those rows beside its namespace's own, and the
// answer says the same of the same results whichever object's drawer asks.
func TestPolicyReportsForResource_ClusterReportsNamingTheObject(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList", prOwnRow),
		prClusterReports:   reportList("ClusterPolicyReportList", cprNamesObjects, cprScopeNamesObject),
	})
	res, err := s.PolicyReportsForResource(context.Background(), "shop", "ConfigMap", "cm-a", "", false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"fail:shop/ConfigMap/cm-a/cluster-first", "fail:shop/ConfigMap/cm-a/own-report",
		"error:shop/ConfigMap/cm-a/cluster-scope", "warn:shop/ConfigMap/cm-a/cluster-later",
	}
	if got := rowWords(res); !reflect.DeepEqual(got, want) || res.Totals != counts(0, 2, 1, 1, 0) {
		t.Errorf("rows %v totals %+v, want %v", got, res.Totals, want)
	}
	if res.ClusterReportsError != "" {
		t.Errorf("read and yet named as not read: %q", res.ClusterReportsError)
	}
	if none, err := s.PolicyReportsForResource(context.Background(), "shop", "ConfigMap", "cm-b", "", false); err != nil || len(none.Rows) != 0 {
		t.Errorf("another object: %+v %v", none, err)
	}
}

// A cluster report's row about a workload's pod comes along with the workload's rows, named after the pod.
func TestPolicyReportsForResource_ClusterReportsNamingAWorkloadsPod(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList"),
		prClusterReports: reportList("ClusterPolicyReportList", `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"ClusterPolicyReport","metadata":{"name":"r"},"results":[`+
			`{"policy":"cluster-pod","result":"fail","resources":[{"apiVersion":"v1","kind":"Pod","name":"web-a","namespace":"shop"}]}]}`),
		"/apis/apps/v1/namespaces/shop/replicasets": func(w http.ResponseWriter) {
			_, _ = w.Write([]byte(`{"apiVersion":"apps/v1","kind":"ReplicaSetList","metadata":{},"items":[{"metadata":{"name":"web-1","namespace":"shop","ownerReferences":[{"apiVersion":"apps/v1","kind":"Deployment","name":"web","controller":true}]},"spec":{"selector":{}}}]}`))
		},
		"/apis/batch/v1/namespaces/shop/jobs": func(w http.ResponseWriter) {
			_, _ = w.Write([]byte(`{"apiVersion":"batch/v1","kind":"JobList","metadata":{},"items":[]}`))
		},
		"/api/v1/namespaces/shop/pods": func(w http.ResponseWriter) {
			_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"PodList","metadata":{},"items":[{"metadata":{"name":"web-a","namespace":"shop","ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"web-1","controller":true}]},"spec":{"containers":[{"name":"c"}]}}]}`))
		},
	})
	res, err := s.PolicyReportsForResource(context.Background(), "shop", "Deployment", "web", "apps/v1", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowWords(res); !reflect.DeepEqual(got, []string{"fail:shop/Pod/web-a/cluster-pod"}) {
		t.Errorf("rows %v, want the pod's row", got)
	}
}

// Every drawer open does not list the cluster's reports: one read a minute per identity, the one a cluster-scoped
// object's drawer reads; a forced read goes to the cluster.
func TestPolicyReportsForResource_ClusterReportsAreReadOnceAMinute(t *testing.T) {
	s, srv := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList", prOwnRow),
		prClusterReports:   reportList("ClusterPolicyReportList", cprNamesObjects),
	})
	ctx := context.Background()
	for _, name := range []string{"cm-a", "cm-b", "cm-c"} {
		if _, err := s.PolicyReportsForResource(ctx, "shop", "ConfigMap", name, "", false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.PolicyReportsForClusterResource(ctx, "Namespace", "shop", "", false); err != nil {
		t.Fatal(err)
	}
	if n := srv.count("/clusterpolicyreports"); n != 1 {
		t.Fatalf("the cluster reports were listed %d times for three drawers and a cluster-scoped one: %v", n, srv.paths)
	}
	if _, err := s.PolicyReportsForResource(ctx, "shop", "ConfigMap", "cm-a", "", true); err != nil || srv.count("/clusterpolicyreports") != 2 {
		t.Fatalf("a forced read goes to the cluster: %v %v", err, srv.paths)
	}
	other := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u2"})
	if _, err := s.PolicyReportsForResource(other, "shop", "ConfigMap", "cm-a", "", false); err != nil || srv.count("/clusterpolicyreports") != 3 {
		t.Fatalf("another identity reads for itself: %v %v", err, srv.paths)
	}
}

// A refusal of the cluster reports is said beside the namespace's rows, which stay: "none" would be an answer nobody read.
func TestPolicyReportsForResource_ClusterReportsRefusedAreNamed(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList", prOwnRow),
		prClusterReports:   clusterReportsRefused,
	})
	res, err := s.PolicyReportsForResource(context.Background(), "shop", "ConfigMap", "cm-a", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowWords(res); !reflect.DeepEqual(got, []string{"fail:shop/ConfigMap/cm-a/own-report"}) {
		t.Errorf("rows %v", got)
	}
	if !strings.Contains(res.ClusterReportsError, `cannot list resource "clusterpolicyreports"`) {
		t.Errorf("cluster reports error = %q", res.ClusterReportsError)
	}
	var keys map[string]interface{}
	if b, _ := json.Marshal(res); json.Unmarshal(b, &keys) != nil || keys["cluster_reports_error"] != res.ClusterReportsError {
		t.Errorf("the answer does not carry it: %s", b)
	}
}

// A cluster serving no ClusterPolicyReport kind has nothing unread to name.
func TestPolicyReportsForResource_NoClusterReportKindIsNoNotice(t *testing.T) {
	s, srv := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList", prOwnRow),
	})
	res, err := s.PolicyReportsForResource(context.Background(), "shop", "ConfigMap", "cm-a", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowWords(res); !reflect.DeepEqual(got, []string{"fail:shop/ConfigMap/cm-a/own-report"}) || res.ClusterReportsError != "" {
		t.Errorf("rows %v, cluster reports error %q", got, res.ClusterReportsError)
	}
	if srv.count("/clusterpolicyreports") != 1 {
		t.Errorf("the kind was not asked for: %v", srv.paths)
	}
}

// A grant limited to namespaces is not given the cluster reports, as its summary leaves them out and without asking the
// cluster; its drawer says so.
func TestPolicyReportsForResource_AGrantLimitedToNamespacesIsTold(t *testing.T) {
	s, srv := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList", prOwnRow),
		prClusterReports:   reportList("ClusterPolicyReportList", cprNamesObjects),
	})
	scoped := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"shop"}}})
	res, err := s.PolicyReportsForResource(scoped, "shop", "ConfigMap", "cm-a", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowWords(res); !reflect.DeepEqual(got, []string{"fail:shop/ConfigMap/cm-a/own-report"}) {
		t.Errorf("rows %v", got)
	}
	if !strings.Contains(res.ClusterReportsError, "outside a grant limited to namespaces") {
		t.Errorf("cluster reports error = %q", res.ClusterReportsError)
	}
	if n := srv.count("/clusterpolicyreports"); n != 0 {
		t.Errorf("the cluster reports were asked for %d times: %v", n, srv.paths)
	}
}

// A cluster report holding more than one read takes may hold more about this object: the drawer says so.
func TestPolicyReportsForResource_ClusterReportsCutAreNamed(t *testing.T) {
	s, _ := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList", prOwnRow),
	})
	c := policyReportCacheFor("default")
	c.mu.Lock()
	c.sets["*cluster|as:"] = policyReportSet{at: time.Now(), truncated: true, reports: policyReportMaxReports}
	c.mu.Unlock()
	res, err := s.PolicyReportsForResource(context.Background(), "shop", "ConfigMap", "cm-a", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.ClusterReportsError, "5000") {
		t.Errorf("cluster reports error = %q", res.ClusterReportsError)
	}
}

// A cluster report's label selector picks cluster-scoped objects: a namespaced object's drawer does not read its labels for one.
func TestPolicyReportsForResource_AClusterReportsSelectorIsNotHeldToAnObjectOfANamespace(t *testing.T) {
	s, srv := policyReportFake(t, map[string]func(http.ResponseWriter){
		prNamespaceReports: reportList("PolicyReportList", prOwnRow),
		prClusterReports: reportList("ClusterPolicyReportList", `{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"ClusterPolicyReport","metadata":{"name":"r"},"results":[`+
			`{"policy":"nodes-need-zone","result":"fail","resourceSelector":{"matchLabels":{"pool":"gpu"}}}]}`),
	})
	withPolicyDiscovery(s)
	res, err := s.PolicyReportsForResource(context.Background(), "shop", "ConfigMap", "cm-a", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowWords(res); !reflect.DeepEqual(got, []string{"fail:shop/ConfigMap/cm-a/own-report"}) || res.SelectorError != "" {
		t.Errorf("rows %v, selector error %q", got, res.SelectorError)
	}
	for _, p := range srv.paths {
		if strings.Contains(p, "/configmaps/") {
			t.Errorf("read the object for a selector that cannot pick it: %s", p)
		}
	}
}
