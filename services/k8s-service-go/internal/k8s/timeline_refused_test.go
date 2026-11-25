package k8s

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A source a namespace of a limited grant refused counts what the others hold and is named with that namespace; a source
// refused in every one is not read, as before.
func TestTimelineChanges_ANamespaceOfAGrantThatRefusedASourceIsNamed(t *testing.T) {
	now, since, until := chgWindow()
	fixture := func(refuse ...string) *changesAPI {
		api := &changesAPI{apps: []map[string]interface{}{}, refuse: map[string]bool{}}
		for _, ns := range []string{"alpha", "beta"} {
			api.cms = append(api.cms, corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "cfg-" + ns, Namespace: ns, CreationTimestamp: metav1.NewTime(now.Add(-time.Hour))}})
		}
		for _, r := range refuse {
			api.refuse[r] = true
		}
		return api
	}
	grant := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"alpha", "beta"}}})

	whole := chgRead(t, fixture().service(t), grant, "", since, until)
	if _, ok := whole.Summary["not_read_in"]; ok || whole.Summary["by_source"].(map[string]interface{})["configmaps"] != 2 {
		t.Fatalf("nothing refused: %v", whole.Summary)
	}

	res := chgRead(t, fixture("beta/configmaps", "beta/pods", "alpha/pods").service(t), grant, "", since, until)
	want := map[string]string{"configmaps": "not read in beta: list configmaps: configmaps is forbidden"}
	if got := res.Summary["not_read_in"]; !reflect.DeepEqual(got, want) {
		t.Errorf("not_read_in %v, want %v", got, want)
	}
	if got := res.Summary["not_read"]; !reflect.DeepEqual(got, map[string]string{"pods": "list pods: pods is forbidden"}) {
		t.Errorf("not_read %v", got)
	}
	by := res.Summary["by_source"].(map[string]interface{})
	if by["configmaps"] != 1 || by["pods"] != nil || len(chgOfKind(res, "ConfigMap")) != 1 {
		t.Errorf("by_source %v", by)
	}

	// one namespace asked, or a caller of the whole cluster: as before
	if res = chgRead(t, fixture("beta/configmaps").service(t), grant, "beta", since, until); res.Summary["not_read_in"] != nil || !reflect.DeepEqual(res.Summary["not_read"], map[string]string{"configmaps": "list configmaps: configmaps is forbidden"}) {
		t.Errorf("one namespace: %v", res.Summary)
	}
	if res = chgRead(t, fixture("beta/configmaps").service(t), context.Background(), "", since, until); res.Summary["not_read_in"] != nil {
		t.Errorf("the cluster: %v", res.Summary)
	}
}

// The Timeline of every namespace of a limited grant names the ones whose events or rollouts were refused.
func TestNamespaceTimeline_ANamespaceOfAGrantThatWasNotReadIsNamed(t *testing.T) {
	read := func(ctx context.Context, namespace string, refused ...string) map[string]interface{} {
		t.Helper()
		res, err := refusingAPI(t, refused...).GetNamespaceTimeline(ctx, namespace, 24, 100, "")
		if err != nil {
			t.Fatal(err)
		}
		return res.Summary
	}
	grant := scopedCaller([]string{"a", "b"})

	if got := read(grant, ""); got["not_read_in"] != nil {
		t.Errorf("nothing refused: %v", got)
	}
	got := read(grant, "", "b/events")["not_read_in"]
	if want := map[string]string{"events": `not read in b: events is forbidden in the namespace "b"`}; !reflect.DeepEqual(got, want) {
		t.Errorf("events: %v", got)
	}
	got = read(grant, "", "a/replicasets")["not_read_in"]
	if want := map[string]string{"rollouts": `not read in a: list replicasets for timeline: replicasets is forbidden in the namespace "a"`}; !reflect.DeepEqual(got, want) {
		t.Errorf("rollouts: %v", got)
	}
	// refused in all of them: the rollouts' own error, as before
	whole := read(grant, "", "a/replicasets", "b/replicasets")
	if whole["not_read_in"] != nil || whole["rollouts_error"] != `list replicasets for timeline: replicasets is forbidden in the namespace "a"` {
		t.Errorf("all: %v", whole)
	}
	// one namespace, or the whole cluster: the keys it had
	for _, s := range []map[string]interface{}{read(grant, "a"), read(context.Background(), "")} {
		keys, _ := json.Marshal(s)
		if s["not_read_in"] != nil || s["rollouts_error"] != nil {
			t.Errorf("%s", keys)
		}
	}
}
