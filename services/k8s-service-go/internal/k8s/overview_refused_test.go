package k8s

import (
	"context"
	"reflect"
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The overview counts what the caller's own identity may list, as kubectl as that identity would: a kind the cluster
// refuses it is null and named in "refused" — across the cluster, and inside a scoped grant, where a kind listable in
// some of its namespaces is counted there only.
func TestGetClusterOverview_CountsWhatTheCallerMayList(t *testing.T) {
	allow := map[string]bool{} // "group/resource@namespace"
	authz := fake.NewSimpleClientset()
	authz.PrependReactor("create", "selfsubjectaccessreviews", func(a k8stesting.Action) (bool, runtime.Object, error) {
		ra := a.(k8stesting.CreateAction).GetObject().(*authorizationv1.SelfSubjectAccessReview).Spec.ResourceAttributes
		ok := ra.Verb == "list" && allow[ra.Group+"/"+ra.Resource+"@"+ra.Namespace]
		return true, &authorizationv1.SelfSubjectAccessReview{Status: authorizationv1.SubjectAccessReviewStatus{Allowed: ok}}, nil
	})
	s := &Service{}
	b := &clientBundle{cacheClient: fake.NewSimpleClientset(overviewObjects()...), authz: authz.AuthorizationV1()}
	s.defaultBundle.Store(b)
	t.Cleanup(func() { _ = b.Close() })

	// across the cluster: the namespaces and the services only
	allow["/namespaces@"], allow["/services@"] = true, true
	ov, err := s.GetClusterOverview(context.Background())
	if err != nil {
		t.Fatalf("GetClusterOverview: %v", err)
	}
	if ov["total_namespaces"] != 2 || ov["total_services"] != 1 {
		t.Errorf("the listable counts = namespaces %v, services %v; want 2, 1", ov["total_namespaces"], ov["total_services"])
	}
	for _, k := range []string{"total_pods", "pod_status", "total_deployments", "total_pvcs", "total_pvs", "node_count"} {
		if v, ok := ov[k]; !ok || !reflect.ValueOf(&v).Elem().IsNil() {
			t.Errorf("%s = %v, want null", k, v)
		}
	}
	if got, want := ov["refused"], []string{"pods", "deployments", "persistentvolumeclaims", "persistentvolumes", "nodes"}; !reflect.DeepEqual(got, want) {
		t.Errorf("refused = %v, want %v", got, want)
	}

	// a grant of a and b: pods in a only, deployments in neither, services and PVCs in both
	ctx := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u2", Namespaces: map[string][]string{"default": {"a", "b"}}})
	for _, k := range []string{"/pods@a", "/services@a", "/services@b", "/persistentvolumeclaims@a", "/persistentvolumeclaims@b"} {
		allow[k] = true
	}
	ov, err = s.GetClusterOverview(ctx)
	if err != nil {
		t.Fatalf("scoped GetClusterOverview: %v", err)
	}
	if ov["total_pods"] != 2 || ov["total_services"] != 1 || ov["total_pvcs"] != 1 {
		t.Errorf("scoped counts = pods %v, services %v, pvcs %v; want 2 (a only), 1, 1", ov["total_pods"], ov["total_services"], ov["total_pvcs"])
	}
	if st, _ := ov["pod_status"].(map[string]int); st["Running"] != 2 || st["Pending"] != 0 || st["Failed"] != 0 {
		t.Errorf("pod_status = %v, want a's two Running only", ov["pod_status"])
	}
	if v := ov["total_deployments"]; v != nil {
		t.Errorf("total_deployments = %v, want null", v)
	}
	if got := ov["refused"]; !reflect.DeepEqual(got, []string{"deployments"}) {
		t.Errorf("scoped refused = %v, want [deployments]", got)
	}
}
