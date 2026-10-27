package k8s

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func scopedCtx(scope ...string) context.Context {
	p := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"c": {"resource.*.read"}}}
	if len(scope) > 0 {
		p.Namespaces = map[string][]string{"c": scope}
	}
	return auth.WithPayload(cluster.WithID(context.Background(), "c"), p)
}

func TestListAcrossNamespaces(t *testing.T) {
	s := &Service{}
	var mu sync.Mutex
	var asked []string
	list := func(ns string) ([]map[string]interface{}, error) {
		mu.Lock()
		asked = append(asked, ns)
		mu.Unlock()
		switch ns {
		case "gone":
			return nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "", errors.New("no binding"))
		case "down":
			return nil, errors.New("apiserver down")
		}
		return []map[string]interface{}{{"namespace": ns}}, nil
	}
	// Unscoped: one call with "".
	out, err := s.listAcrossNamespaces(context.Background(), list)
	if err != nil || !reflect.DeepEqual(asked, []string{""}) || len(out) != 1 {
		t.Fatalf("unscoped: %v %v %v", out, asked, err)
	}
	// Scoped: one call per namespace, merged in order, a refused namespace skipped.
	asked = nil
	out, err = s.listAcrossNamespaces(scopedCtx("api", "gone", "web"), list)
	if err != nil {
		t.Fatalf("scoped: %v", err)
	}
	if got := []string{out[0]["namespace"].(string), out[1]["namespace"].(string)}; len(out) != 2 || !reflect.DeepEqual(got, []string{"api", "web"}) {
		t.Fatalf("scoped merge: %v", out)
	}
	if len(asked) != 3 {
		t.Fatalf("every namespace asked once: %v", asked)
	}
	// Any other error surfaces.
	if _, err := s.listAcrossNamespaces(scopedCtx("api", "down"), list); err == nil {
		t.Fatal("a cluster error must surface")
	}
	// Refused in every namespace: the refusal, not an empty list.
	if _, err := s.listAcrossNamespaces(scopedCtx("gone"), list); !apierrors.IsForbidden(err) {
		t.Fatalf("refused everywhere: %v", err)
	}
}

func TestOverviewFor_Scope(t *testing.T) {
	cs := fake.NewSimpleClientset(overviewObjects()...)
	ci := newClusterInformers(cs, time.Hour, nil)
	t.Cleanup(ci.stopNow)
	if !ci.waitSynced(context.Background(), 5*time.Second) {
		t.Fatal("informers did not sync")
	}
	ov := ci.overviewFor([]string{"a", "missing"})
	want := map[string]int{"total_namespaces": 1, "total_pods": 2, "total_services": 1, "total_deployments": 1, "total_pvcs": 1, "total_pvs": 0, "node_count": 0}
	for k, v := range want {
		if ov[k] != v {
			t.Errorf("%s = %v, want %d", k, ov[k], v)
		}
	}
	if ov["scoped"] != true {
		t.Error("a scoped overview says so")
	}
	status := ov["pod_status"].(map[string]int)
	if status["Running"] != 2 || status["Pending"] != 0 || status["Failed"] != 0 {
		t.Errorf("pod_status counts namespace a only: %v", status)
	}
	if whole := ci.overviewFor(nil); whole["scoped"] != nil || whole["total_pods"] != 4 {
		t.Errorf("unscoped overview unchanged: %v", whole)
	}
}
