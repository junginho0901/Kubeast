package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	leaserow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/lease"
)

// clusterDrawersAPI answers GETs of the objects it holds by their API path and events lists as the API server filters
// them (involvedObject name and kind, the namespace in the path); refuseEvents answers 403 to every events list.
type clusterDrawersAPI struct {
	objects      map[string]interface{}
	events       []corev1.Event
	refuseEvents bool
}

func (a *clusterDrawersAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if o, ok := a.objects[r.URL.Path]; ok {
		_ = json.NewEncoder(w).Encode(o)
		return
	}
	ns, namespaced := strings.CutPrefix(strings.TrimSuffix(r.URL.Path, "/events"), "/api/v1/namespaces/")
	if !strings.HasSuffix(r.URL.Path, "/events") || (!namespaced && r.URL.Path != "/api/v1/events") {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		return
	}
	if a.refuseEvents {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}`))
		return
	}
	want := map[string]string{}
	for _, kv := range strings.Split(r.URL.Query().Get("fieldSelector"), ",") {
		k, v, _ := strings.Cut(kv, "=")
		want[k] = v
	}
	items := []corev1.Event{}
	for _, e := range a.events {
		if (!namespaced || e.Namespace == ns) && e.InvolvedObject.Name == want["involvedObject.name"] && e.InvolvedObject.Kind == want["involvedObject.kind"] {
			items = append(items, e)
		}
	}
	_ = json.NewEncoder(w).Encode(corev1.EventList{TypeMeta: metav1.TypeMeta{Kind: "EventList", APIVersion: "v1"}, Items: items})
}

func newClusterDrawersService(t *testing.T, api *clusterDrawersAPI) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	return s
}

func reasons(out map[string]interface{}) []string {
	got := []string{}
	events, _ := out["events"].([]map[string]interface{})
	for _, e := range events {
		got = append(got, e["reason"].(string))
	}
	return got
}

// the value as the drawer receives it: the answer through JSON
func asWire(v interface{}) interface{} {
	raw, _ := json.Marshal(v)
	var out interface{}
	_ = json.Unmarshal(raw, &out)
	return out
}

// A ClusterRole's rules and aggregation rule reach the drawer as the API writes them: a rule of non-resource URLs only
// (system:discovery's kind) keeps its URLs and a selector its matchExpressions — kubectl describe lists the URLs in
// the Non-Resource URLs column, and the drawer read both under these names while describe left them out.
func TestDescribeClusterRole_RulesAndAggregationAsTheAPIWritesThem(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	cr := rbacv1.ClusterRole{
		TypeMeta:   metav1.TypeMeta{Kind: "ClusterRole", APIVersion: "rbac.authorization.k8s.io/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "reader", UID: "c1", ResourceVersion: "7"},
		Rules: []rbacv1.PolicyRule{
			{APIGroups: []string{"", "apps"}, Resources: []string{"pods", "deployments"}, Verbs: []string{"get", "list"}, ResourceNames: []string{"web"}},
			{NonResourceURLs: []string{"/healthz", "/healthz/*"}, Verbs: []string{"get"}},
		},
		AggregationRule: &rbacv1.AggregationRule{ClusterRoleSelectors: []metav1.LabelSelector{{
			MatchLabels:      map[string]string{"rbac.example.com/aggregate": "true"},
			MatchExpressions: []metav1.LabelSelectorRequirement{{Key: "tier", Operator: metav1.LabelSelectorOpIn, Values: []string{"a", "b"}}},
		}}},
	}
	s := newClusterDrawersService(t, &clusterDrawersAPI{
		objects: map[string]interface{}{"/apis/rbac.authorization.k8s.io/v1/clusterroles/reader": cr},
		events: []corev1.Event{
			gatewayEvent("default", "ClusterRole", "reader", "Aggregated", now.Add(-time.Minute)),
			gatewayEvent("kube-system", "ClusterRole", "reader", "Updated", now),
			gatewayEvent("default", "ClusterRoleBinding", "reader", "Elsewhere", now),
		},
	})
	out, err := s.DescribeClusterRole(context.Background(), "reader")
	if err != nil {
		t.Fatalf("DescribeClusterRole: %v", err)
	}
	wantRules := []interface{}{
		map[string]interface{}{"apiGroups": []interface{}{"", "apps"}, "resources": []interface{}{"pods", "deployments"}, "verbs": []interface{}{"get", "list"}, "resourceNames": []interface{}{"web"}},
		map[string]interface{}{"nonResourceURLs": []interface{}{"/healthz", "/healthz/*"}, "verbs": []interface{}{"get"}},
	}
	if got := asWire(out["rules"]); !reflect.DeepEqual(got, wantRules) {
		t.Errorf("rules = %#v\nwant %#v", got, wantRules)
	}
	wantAgg := map[string]interface{}{"clusterRoleSelectors": []interface{}{map[string]interface{}{
		"matchLabels":      map[string]interface{}{"rbac.example.com/aggregate": "true"},
		"matchExpressions": []interface{}{map[string]interface{}{"key": "tier", "operator": "In", "values": []interface{}{"a", "b"}}},
	}}}
	if got := asWire(out["aggregation_rule"]); !reflect.DeepEqual(got, wantAgg) {
		t.Errorf("aggregation_rule = %#v\nwant %#v", got, wantAgg)
	}
	if out["rules_count"] != 2 {
		t.Errorf("rules_count = %v", out["rules_count"])
	}
	if got := reasons(out); !reflect.DeepEqual(got, []string{"Updated", "Aggregated"}) {
		t.Errorf("events = %v, want the ClusterRole's two, newest first", got)
	}

	// a role with no rules and no aggregation: an empty list and no rule
	s = newClusterDrawersService(t, &clusterDrawersAPI{objects: map[string]interface{}{
		"/apis/rbac.authorization.k8s.io/v1/clusterroles/empty": rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: "empty"}},
	}})
	out, err = s.DescribeClusterRole(context.Background(), "empty")
	if err != nil {
		t.Fatalf("DescribeClusterRole(empty): %v", err)
	}
	if got := asWire(out["rules"]); !reflect.DeepEqual(got, []interface{}{}) {
		t.Errorf("rules of a role without any = %#v", got)
	}
	if out["aggregation_rule"] != nil {
		t.Errorf("aggregation_rule of a role without one = %#v", out["aggregation_rule"])
	}
}

// The drawers of a ClusterRole and a ClusterRoleBinding get the events about them, or, when the events cannot be read,
// no list and the reason (events_error) — not an empty list the drawer would show as "None" — and open all the same.
func TestDescribeClusterRBAC_EventsOrWhyNot(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	objects := map[string]interface{}{
		"/apis/rbac.authorization.k8s.io/v1/clusterroles/view":        rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: "view"}},
		"/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/view": rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{Name: "view"}, RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "view"}},
	}
	events := []corev1.Event{
		gatewayEvent("default", "ClusterRoleBinding", "view", "Bound", now),
		gatewayEvent("default", "ClusterRole", "view", "Seen", now),
	}
	for _, refuse := range []bool{false, true} {
		s := newClusterDrawersService(t, &clusterDrawersAPI{objects: objects, events: events, refuseEvents: refuse})
		cr, err := s.DescribeClusterRole(context.Background(), "view")
		if err != nil {
			t.Fatalf("DescribeClusterRole: %v", err)
		}
		crb, err := s.DescribeClusterRoleBinding(context.Background(), "view")
		if err != nil {
			t.Fatalf("DescribeClusterRoleBinding: %v", err)
		}
		want := [2][]string{{"Seen"}, {"Bound"}}
		for i, out := range []map[string]interface{}{cr, crb} {
			if refuse {
				checkEventsRefused(t, out)
				continue
			}
			if _, ok := out["events"].([]map[string]interface{}); !ok || out["events_error"] != nil {
				t.Errorf("events = %#v, events_error = %#v, want a list and no error", out["events"], out["events_error"])
			}
			if got := reasons(out); !reflect.DeepEqual(got, want[i]) {
				t.Errorf("events = %v, want %v", got, want[i])
			}
		}
	}
}

// An admission policy's drawer lists the events about it as the other drawers do — kubectl describe's generic
// describer lists them — next to its bindings.
func TestDescribeAdmissionPolicies_Events(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	fail := admissionregistrationv1.Ignore
	vap := admissionregistrationv1.ValidatingAdmissionPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: "guard", UID: "v1"},
		Spec:       admissionregistrationv1.ValidatingAdmissionPolicySpec{FailurePolicy: &fail, Validations: []admissionregistrationv1.Validation{{Expression: "true"}}},
	}
	vapb := admissionregistrationv1.ValidatingAdmissionPolicyBindingList{Items: []admissionregistrationv1.ValidatingAdmissionPolicyBinding{
		{ObjectMeta: metav1.ObjectMeta{Name: "guard-b"}, Spec: admissionregistrationv1.ValidatingAdmissionPolicyBindingSpec{PolicyName: "guard"}},
		{ObjectMeta: metav1.ObjectMeta{Name: "other"}, Spec: admissionregistrationv1.ValidatingAdmissionPolicyBindingSpec{PolicyName: "other"}},
	}}
	mp := admissionregistrationv1.MutatingAdmissionPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: "guard", UID: "m1"},
		Spec:       admissionregistrationv1.MutatingAdmissionPolicySpec{ReinvocationPolicy: admissionregistrationv1.NeverReinvocationPolicy},
	}
	mpb := admissionregistrationv1.MutatingAdmissionPolicyBindingList{}
	api := &clusterDrawersAPI{
		objects: map[string]interface{}{
			"/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/guard": vap,
			"/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings": vapb,
			"/apis/admissionregistration.k8s.io/v1/mutatingadmissionpolicies/guard":   mp,
			"/apis/admissionregistration.k8s.io/v1/mutatingadmissionpolicybindings":   mpb,
		},
		events: []corev1.Event{
			gatewayEvent("default", "ValidatingAdmissionPolicy", "guard", "TypeChecked", now.Add(-2*time.Minute)),
			gatewayEvent("kube-system", "ValidatingAdmissionPolicy", "guard", "Audited", now),
			gatewayEvent("default", "MutatingAdmissionPolicy", "guard", "Mutated", now.Add(-time.Minute)),
		},
	}
	s := newClusterDrawersService(t, api)
	v, err := s.DescribeValidatingAdmissionPolicy(context.Background(), "guard")
	if err != nil {
		t.Fatalf("DescribeValidatingAdmissionPolicy: %v", err)
	}
	if got := reasons(v); !reflect.DeepEqual(got, []string{"Audited", "TypeChecked"}) {
		t.Errorf("VAP events = %v", got)
	}
	if v["bindings_count"] != 1 {
		t.Errorf("VAP bindings_count = %v", v["bindings_count"])
	}
	m, err := s.DescribeMutatingAdmissionPolicy(context.Background(), "guard")
	if err != nil {
		t.Fatalf("DescribeMutatingAdmissionPolicy: %v", err)
	}
	if got := reasons(m); !reflect.DeepEqual(got, []string{"Mutated"}) {
		t.Errorf("MAP events = %v", got)
	}

	// events refused: no list but the reason, the policy all the same
	api.refuseEvents = true
	v, err = s.DescribeValidatingAdmissionPolicy(context.Background(), "guard")
	if err != nil {
		t.Fatalf("DescribeValidatingAdmissionPolicy (events refused): %v", err)
	}
	checkEventsRefused(t, v)
	if v["bindings_count"] != 1 {
		t.Errorf("VAP bindings_count with events refused = %v", v["bindings_count"])
	}
}

// checkEventsRefused: a describe answer whose events list was refused has no events but the reason, so the drawer says
// they could not be read instead of "None".
func checkEventsRefused(t *testing.T, out map[string]interface{}) {
	t.Helper()
	if _, has := out["events"]; has {
		t.Errorf("events refused: events = %#v, want none", out["events"])
	}
	if msg, _ := out["events_error"].(string); msg == "" {
		t.Errorf("events refused: events_error = %#v, want the reason", out["events_error"])
	}
}

// A Lease's renew and acquire times are the instants the object holds, in UTC: decoded, a MicroTime is in the
// process's local zone, and the literal "Z" of the old layout labelled a local time as UTC.
func TestFormatLeaseDetail_TimesInUTC(t *testing.T) {
	kst := time.FixedZone("KST", 9*3600)
	renew := metav1.NewMicroTime(time.Date(2026, 11, 4, 16, 0, 5, 123456000, kst))
	acquire := metav1.NewMicroTime(time.Date(2026, 11, 4, 15, 58, 0, 0, kst))
	holder, dur, transitions := "node-a", int32(40), int32(3)
	out := leaserow.Info(&coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{Name: "node-a", Namespace: "kube-node-lease"},
		Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder, LeaseDurationSeconds: &dur, LeaseTransitions: &transitions, RenewTime: &renew, AcquireTime: &acquire},
	})
	if out["renew_time"] != "2026-11-04T07:00:05Z" || out["acquire_time"] != "2026-11-04T06:58:00Z" {
		t.Errorf("renew_time %v acquire_time %v, want 2026-11-04T07:00:05Z and 2026-11-04T06:58:00Z", out["renew_time"], out["acquire_time"])
	}
	if out["holder_identity"] != "node-a" || out["lease_duration_seconds"] != int32(40) || out["lease_transitions"] != int32(3) {
		t.Errorf("spec = %v %v %v", out["holder_identity"], out["lease_duration_seconds"], out["lease_transitions"])
	}
}
