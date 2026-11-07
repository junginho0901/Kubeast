package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const (
	wholeOverview = `{"total_namespaces":7,"total_pods":41,"total_services":12,"total_deployments":9,"total_pvcs":3,"total_pvs":4,` +
		`"pod_status":{"Running":38,"Pending":2,"Failed":1,"Succeeded":0,"Unknown":0},"node_count":5,"cluster_version":"v1.35.0"}`
	refusedOverview = `{"total_namespaces":7,"total_pods":null,"total_services":12,"total_deployments":null,"total_pvcs":null,"total_pvs":null,` +
		`"pod_status":null,"node_count":null,"refused":["pods","deployments","persistentvolumeclaims","persistentvolumes","nodes"],"cluster_version":"v1.35.0"}`
	scopedOverview = `{"scoped":true,"total_namespaces":1,"total_pods":2,"total_services":1,"total_deployments":null,"total_pvcs":0,"total_pvs":0,` +
		`"pod_status":{"Running":2,"Pending":0,"Failed":0,"Succeeded":0,"Unknown":0},"node_count":0,"refused":["deployments"],"cluster_version":"v1.35.0"}`
)

// kubectlThatCountsOtherNumbers answers every list with two items, so an answer read through kubectl shows in the values.
func kubectlThatCountsOtherNumbers(t *testing.T) *[][]string {
	t.Helper()
	return fakeKubectl(t, func(args []string) (string, error) {
		if verb(args)[0] == "version" {
			return `{"serverVersion":{"gitVersion":"v0.0.0-kubectl"}}`, nil
		}
		return `{"items":[{"status":{"phase":"Running"}},{"status":{"phase":"Running"}}]}`, nil
	})
}

func overviewFrom(t *testing.T, raw string) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestClusterOverview_AnswersWhatTheDashboardReads(t *testing.T) {
	calls := kubectlThatCountsOtherNumbers(t)
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, wholeOverview })
	out, err := handleGetClusterOverview(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if got, want := decode(t, out), overviewFrom(t, wholeOverview); !reflect.DeepEqual(got, want) {
		t.Errorf("answer:\n got %v\nwant %v", got, want)
	}
	if len(*seen) != 1 {
		t.Fatalf("the dashboard's route was asked %d times", len(*seen))
	}
	r := (*seen)[0]
	if r.URL.Path != "/api/v1/overview" || r.URL.Query().Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Errorf("request: %s %s auth=%q", r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"))
	}
	if len(*calls) != 0 {
		t.Errorf("the overview ran kubectl: %v", *calls)
	}
}

func TestClusterOverview_AKindTheIdentityMayNotListIsNotCounted(t *testing.T) {
	fakeKubectl(t, func(args []string) (string, error) {
		if verb(args)[1] == "services" {
			return kubectlErr(`Error from server (Forbidden): services is forbidden: User "reader" cannot list resource "services"`)
		}
		return `{"items":[]}`, nil
	})
	fakeK8sService(t, func(*http.Request) (int, string) { return 200, refusedOverview })
	out, err := handleGetClusterOverview(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatalf("one refused kind failed the tool: %v", err)
	}
	if got, want := decode(t, out), overviewFrom(t, refusedOverview); !reflect.DeepEqual(got, want) {
		t.Errorf("answer:\n got %v\nwant %v", got, want)
	}
}

func TestClusterOverview_AnIdentityThatMayNotListNamespacesIsToldSo(t *testing.T) {
	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`Error from server (Forbidden): namespaces is forbidden`)
	})
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 403, `{"detail":"your identity in this cluster may not list namespaces, so the cluster overview is not shown"}`
	})
	out, err := handleGetClusterOverview(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatalf("a refusal is an answer: %v", err)
	}
	m := decode(t, out)
	if m["status"] != "forbidden" || !strings.Contains(m["reason"].(string), "may not list namespaces") {
		t.Errorf("answer: %s", out)
	}
	if _, has := m["total_pods"]; has {
		t.Errorf("a refused overview has no counts: %s", out)
	}
}

// The dashboard writes "—" for the nodes of a grant limited to namespaces: the route's 0 means not counted.
func TestClusterOverview_AGrantLimitedToNamespacesIsCountedInsideIt(t *testing.T) {
	kubectlThatCountsOtherNumbers(t)
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, scopedOverview })
	out, err := handleGetClusterOverview(ctxFor("c1", "shop"), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 1 || (*seen)[0].URL.Path != "/api/v1/overview" {
		t.Fatalf("the grant's own overview was not asked: %d calls", len(*seen))
	}
	m := decode(t, out)
	for key, want := range map[string]interface{}{"scoped": true, "total_namespaces": float64(1), "total_pods": float64(2), "total_services": float64(1), "total_pvcs": float64(0), "total_deployments": nil, "total_pvs": nil, "node_count": nil} {
		if got, ok := m[key]; !ok || got != want {
			t.Errorf("%s = %v (present %v), want %v", key, got, ok, want)
		}
	}
	for key, want := range map[string]interface{}{"namespaces": []interface{}{"shop"}, "not_counted": []interface{}{"persistentvolumes", "nodes"}, "refused": []interface{}{"deployments"}} {
		if !reflect.DeepEqual(m[key], want) {
			t.Errorf("%s = %v, want %v", key, m[key], want)
		}
	}
	if !reflect.DeepEqual(m["pod_status"], overviewFrom(t, scopedOverview)["pod_status"]) {
		t.Errorf("pod_status = %v", m["pod_status"])
	}
}

func TestClusterOverview_AFailedRouteIsAnErrorAndNotZeroes(t *testing.T) {
	kubectlThatCountsOtherNumbers(t)
	fakeK8sService(t, func(*http.Request) (int, string) { return 500, `{"detail":"list pods: boom"}` })
	out, err := handleGetClusterOverview(ctxFor("c1"), args{}, bearer())
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("out=%s err=%v", out, err)
	}
	if errors.Is(err, errBadRequest) {
		t.Errorf("not the model's arguments: %v", err)
	}
}
