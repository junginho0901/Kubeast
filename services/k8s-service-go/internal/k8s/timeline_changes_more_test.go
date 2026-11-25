package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	applyappsv1 "k8s.io/client-go/applyconfigurations/apps/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// moreObject is an object of one of the further kinds: its metadata, and what else the API server holds of it, which it
// gives only to a request that does not ask for metadata only.
type moreObject struct {
	meta metav1.ObjectMeta
	rest map[string]interface{}
}

// moreAPI is changesAPI serving the further kinds too: Jobs, NetworkPolicies, Services, Deployments and StatefulSets.
type moreAPI struct {
	changesAPI
	objects map[string][]moreObject
}

var moreKinds = map[string]struct{ api, kind string }{
	"jobs":            {"batch/v1", "Job"},
	"networkpolicies": {"networking.k8s.io/v1", "NetworkPolicy"},
	"services":        {"v1", "Service"},
	"deployments":     {"apps/v1", "Deployment"},
	"statefulsets":    {"apps/v1", "StatefulSet"},
}

func (a *moreAPI) serveMore(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	resource := parts[len(parts)-1]
	kind, ours := moreKinds[resource]
	if !ours {
		a.serve(w, r)
		return
	}
	a.mu.Lock()
	a.asked = append(a.asked, changesAsk{r.URL.Path, r.Header.Get("Accept")})
	a.inUse = max(a.inUse, bigReadSlots.InUse())
	a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if a.refuse[resource] {
		chgStatus(w, http.StatusForbidden, "Forbidden", resource+" is forbidden")
		return
	}
	ns := ""
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "namespaces" {
			ns = parts[i+1]
		}
	}
	items, meta := chgPage(&a.changesAPI, chgIn(a.objects[resource], ns, func(o moreObject) string { return o.meta.Namespace }), r)
	if strings.Contains(r.Header.Get("Accept"), "as=PartialObjectMetadataList") {
		metas := []metav1.ObjectMeta{}
		for _, o := range items {
			metas = append(metas, o.meta)
		}
		list := chgMetadata(metas)
		list.ListMeta = meta
		_ = json.NewEncoder(w).Encode(list)
		return
	}
	whole := []map[string]interface{}{}
	for _, o := range items {
		obj := map[string]interface{}{"apiVersion": kind.api, "kind": kind.kind, "metadata": o.meta}
		for k, v := range o.rest {
			obj[k] = v
		}
		whole = append(whole, obj)
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"apiVersion": kind.api, "kind": kind.kind + "List", "metadata": meta, "items": whole})
}

func (a *moreAPI) service(t *testing.T) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(a.serveMore))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	dyn, err := dynamic.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	b := &clientBundle{clientset: cs, dynamic: dyn}
	if a.reviews {
		b.authz = cs.AuthorizationV1()
	}
	s.defaultBundle.Store(b)
	return s
}

// moreWrite is a managedFields entry: who wrote these fields and when, through a subresource or not.
func moreWrite(manager, subresource string, at time.Time, fields string) metav1.ManagedFieldsEntry {
	t := metav1.NewTime(at)
	return metav1.ManagedFieldsEntry{
		Manager: manager, Operation: metav1.ManagedFieldsOperationUpdate, APIVersion: "v1", Time: &t,
		FieldsType: "FieldsV1", FieldsV1: metav1.NewFieldsV1(fields), Subresource: subresource,
	}
}

// moreScale is the entry the API server keeps of a write through a workload's scale subresource: who, and no time, as
// apimachinery's ScaleHandler.ToParent writes it (v0.37.2).
func moreScale(manager string) metav1.ManagedFieldsEntry {
	entry := moreWrite(manager, "scale", time.Time{}, moreScaleFields)
	entry.Time = nil
	return entry
}

// moreCounted is a ReplicaSet whose count its controller last set at.
func moreCounted(rs appsv1.ReplicaSet, at time.Time) appsv1.ReplicaSet {
	rs.ManagedFields = []metav1.ManagedFieldsEntry{
		moreWrite("kube-controller-manager", "", at, `{"f:metadata":{"f:annotations":{}},"f:spec":{"f:replicas":{},"f:selector":{},"f:template":{}}}`),
		moreWrite("kube-controller-manager", "status", at.Add(20*time.Second), `{"f:status":{"f:replicas":{}}}`),
	}
	return rs
}

const (
	moreScaleFields = `{"f:spec":{"f:replicas":{}}}`
	moreApplyFields = `{"f:metadata":{"f:labels":{"f:app":{}}},"f:spec":{"f:replicas":{},"f:selector":{},"f:template":{"f:spec":{"f:containers":{}}}}}`
)

// moreNow is the end of the fixture's window, which is four hours.
var moreNow = time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)

func moreBack(d time.Duration) time.Time { return moreNow.Add(-d) }

// moreFixture is a namespace where every source of the changes view, and each of the further ones, has a change in the
// window.
func moreFixture() *moreAPI {
	month := moreBack(30 * 24 * time.Hour)
	scaled := metav1.NewTime(moreBack(50 * time.Minute))
	desired := func(rs appsv1.ReplicaSet, n string) appsv1.ReplicaSet {
		rs.Annotations["deployment.kubernetes.io/desired-replicas"] = n
		return rs
	}
	revision := func(name string, rev int64, at time.Time, image string) appsv1.ControllerRevision {
		return appsv1.ControllerRevision{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "shop", CreationTimestamp: metav1.NewTime(at), OwnerReferences: chgOwner("StatefulSet", "db")},
			Revision:   rev,
			Data:       runtime.RawExtension{Raw: []byte(`{"spec":{"template":{"spec":{"containers":[{"name":"db","image":"` + image + `"}]}}}}`)},
		}
	}
	a := &moreAPI{changesAPI: changesAPI{
		rs: []appsv1.ReplicaSet{
			moreCounted(desired(chgReplicaSet("shop", "web-1", "web", "1", month, "web:1"), "9"), moreBack(119*time.Minute)),
			moreCounted(desired(chgReplicaSet("shop", "web-2", "web", "2", moreBack(2*time.Hour), "web:2"), "0"), moreBack(45*time.Minute)),
			moreCounted(desired(chgReplicaSet("shop", "api-1", "api", "1", month, "api:1"), "6"), moreBack(50*time.Minute)),
		},
		crs: []appsv1.ControllerRevision{revision("db-a", 1, month, "db:1"), revision("db-b", 2, moreBack(3*time.Hour), "db:2")},
		cms: []corev1.ConfigMap{{ObjectMeta: metav1.ObjectMeta{Name: "settings", Namespace: "shop", CreationTimestamp: metav1.NewTime(month),
			ManagedFields: []metav1.ManagedFieldsEntry{chgWritten("kubectl-edit", moreBack(30*time.Minute))}}, Data: map[string]string{"k": "configmap-value"}}},
		secrets: []corev1.Secret{
			{ObjectMeta: metav1.ObjectMeta{Name: "db-login", Namespace: "shop", CreationTimestamp: metav1.NewTime(month),
				ManagedFields: []metav1.ManagedFieldsEntry{chgWritten("external-secrets", moreBack(40*time.Minute))}}, Data: map[string][]byte{"p": []byte("secret-value")}},
			{ObjectMeta: metav1.ObjectMeta{Name: "sh.helm.release.v1.shop.v2", Namespace: "shop", CreationTimestamp: metav1.NewTime(moreBack(125 * time.Minute)),
				Labels: map[string]string{"owner": "helm", "name": "shop", "version": "2", "status": "deployed"}}},
		},
		hpas: []autoscalingv2.HorizontalPodAutoscaler{{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "shop"},
			Spec:   autoscalingv2.HorizontalPodAutoscalerSpec{ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{Kind: "Deployment", Name: "api", APIVersion: "apps/v1"}},
			Status: autoscalingv2.HorizontalPodAutoscalerStatus{LastScaleTime: &scaled, CurrentReplicas: 5, DesiredReplicas: 6}}},
		nodes: []corev1.Node{{ObjectMeta: metav1.ObjectMeta{Name: "node-a", CreationTimestamp: metav1.NewTime(month)},
			Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionFalse, Reason: "KubeletNotReady", LastTransitionTime: metav1.NewTime(moreBack(20 * time.Minute))}}}}},
		pods: []corev1.Pod{{ObjectMeta: metav1.ObjectMeta{Name: "web-2-x", Namespace: "shop"}, Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{
			{Name: "app", RestartCount: 2, LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1, FinishedAt: metav1.NewTime(moreBack(10 * time.Minute))}}}}}}},
		apps: []map[string]interface{}{{
			"apiVersion": "argoproj.io/v1alpha1", "kind": "Application", "metadata": map[string]interface{}{"name": "shop", "namespace": "argocd"},
			"spec": map[string]interface{}{"destination": map[string]interface{}{"namespace": "shop"}},
			"status": map[string]interface{}{"history": []interface{}{
				map[string]interface{}{"id": int64(1), "revision": "v1.2.3", "deployedAt": moreBack(126 * time.Minute).Format(time.RFC3339)}}},
		}},
	}}
	a.objects = map[string][]moreObject{
		"jobs": {{
			meta: metav1.ObjectMeta{Name: "report-29", Namespace: "shop", CreationTimestamp: metav1.NewTime(moreBack(15 * time.Minute)), OwnerReferences: chgOwner("CronJob", "report"),
				ManagedFields: []metav1.ManagedFieldsEntry{moreWrite("kube-controller-manager", "status", moreBack(14*time.Minute), `{"f:status":{"f:startTime":{}}}`)}},
			rest: map[string]interface{}{"spec": map[string]interface{}{"template": "job-spec-value"}},
		}},
		"networkpolicies": {{
			meta: metav1.ObjectMeta{Name: "deny-all", Namespace: "shop", CreationTimestamp: metav1.NewTime(moreBack(25 * time.Minute)),
				ManagedFields: []metav1.ManagedFieldsEntry{moreWrite("kubectl-create", "", moreBack(25*time.Minute), `{"f:spec":{"f:podSelector":{},"f:policyTypes":{}}}`)}},
			rest: map[string]interface{}{"spec": map[string]interface{}{"policyTypes": []string{"policy-spec-value"}}},
		}},
		"services": {{
			meta: metav1.ObjectMeta{Name: "web", Namespace: "shop", CreationTimestamp: metav1.NewTime(month),
				ManagedFields: []metav1.ManagedFieldsEntry{moreWrite("kubectl-patch", "", moreBack(35*time.Minute), `{"f:spec":{"f:selector":{}}}`)}},
			rest: map[string]interface{}{"spec": map[string]interface{}{"selector": map[string]string{"app": "service-spec-value"}}},
		}},
		"deployments": {
			{meta: metav1.ObjectMeta{Name: "web", Namespace: "shop", CreationTimestamp: metav1.NewTime(month), ManagedFields: []metav1.ManagedFieldsEntry{
				moreWrite("helm", "", moreBack(2*time.Hour), `{"f:spec":{"f:template":{}}}`),
				moreScale("kubectl")}},
				rest: map[string]interface{}{"spec": map[string]interface{}{"template": "deployment-spec-value"}}},
			{meta: metav1.ObjectMeta{Name: "api", Namespace: "shop", CreationTimestamp: metav1.NewTime(month), ManagedFields: []metav1.ManagedFieldsEntry{
				moreScale("kube-controller-manager")}}},
		},
		"statefulsets": {{meta: metav1.ObjectMeta{Name: "db", Namespace: "shop", CreationTimestamp: metav1.NewTime(month), ManagedFields: []metav1.ManagedFieldsEntry{
			moreWrite("kubectl-patch", "", moreBack(55*time.Minute), moreScaleFields)}}}},
	}
	return a
}

// moreOffCases are the reads held to testdata/timeline_changes_off.json.
var moreOffCases = []struct {
	name, namespace string
	api             func() *moreAPI
}{
	{"a namespace", "shop", moreFixture},
	{"every namespace", "", moreFixture},
	{"every namespace, pods not listable across the cluster", "", func() *moreAPI { a := moreFixture(); a.reviews = true; return a }},
	{"sources refused, no Argo CD, two objects a page", "shop", func() *moreAPI {
		a := moreFixture()
		a.refuse, a.apps, a.pageSize = map[string]bool{"secrets": true, "controllerrevisions": true}, nil, 2
		return a
	}},
}

type moreOffAnswer struct {
	Answer   string   `json:"answer"`
	Requests []string `json:"requests"`
}

func moreOffRead(t *testing.T, api *moreAPI, namespace string) moreOffAnswer {
	t.Helper()
	res, err := api.service(t).GetTimelineChanges(context.Background(), namespace, moreBack(4*time.Hour), moreNow, TimelineChangesMax)
	if err != nil {
		t.Fatal(err)
	}
	got := moreOffAnswer{Answer: chgJSON(t, res)}
	for _, ask := range api.paths() {
		request := ask.path
		if ask.accept == metadataListAccept { // the other Accepts are client-go's
			request += " (metadata only)"
		}
		got.Requests = append(got.Requests, request)
	}
	return got
}

// Without the further sources the view answers the same bytes and asks the same lists in the same order as before they
// were written (testdata, read from that code), whatever the namespace holds of the further kinds.
func TestTimelineChangesMore_OffTheAnswerAndTheRequestsAreAsBefore(t *testing.T) {
	raw, err := os.ReadFile("testdata/timeline_changes_off.json")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]moreOffAnswer{}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(moreOffCases) {
		t.Fatalf("%d answers kept, want one for each of the %d reads", len(want), len(moreOffCases))
	}
	for _, c := range moreOffCases {
		got := moreOffRead(t, c.api(), c.namespace)
		if got.Answer != want[c.name].Answer {
			t.Errorf("%s: answer\n%s\nwant\n%s", c.name, got.Answer, want[c.name].Answer)
		}
		if !reflect.DeepEqual(got.Requests, want[c.name].Requests) {
			t.Errorf("%s: requests %q, want %q", c.name, got.Requests, want[c.name].Requests)
		}
	}
}

// --- On ---

func moreReadIn(t *testing.T, ctx context.Context, api *moreAPI, namespace string) *TimelineChangesResult {
	t.Helper()
	res, err := api.service(t).GetTimelineChangesMore(ctx, namespace, moreBack(4*time.Hour), moreNow, TimelineChangesMax)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func moreRead(t *testing.T, api *moreAPI) *TimelineChangesResult {
	t.Helper()
	return moreReadIn(t, context.Background(), api, "shop")
}

func moreBySource(res *TimelineChangesResult) map[string]interface{} {
	return res.Summary["by_source"].(map[string]interface{})
}

// moreLine is a change as one line: when before the window's end, what, of and by whom.
func moreLine(ch TimelineChange) string {
	line := fmt.Sprintf("-%s %s %s: %s", moreNow.Sub(ch.at), ch.Kind, ch.Name, ch.What)
	if ch.To != nil {
		line += fmt.Sprintf(" to %v", ch.To)
	}
	if ch.By != "" {
		line += " by " + ch.By
	}
	if ch.Note != "" {
		line += " (" + ch.Note + ")"
	}
	return line
}

func moreLines(res *TimelineChangesResult, kinds ...string) []string {
	out := []string{}
	for _, ch := range res.Changes {
		if slices.Contains(kinds, ch.Kind) && (ch.What != "rollout") {
			out = append(out, moreLine(ch))
		}
	}
	return out
}

func wantMoreLines(t *testing.T, res *TimelineChangesResult, want []string, kinds ...string) {
	t.Helper()
	if got := moreLines(res, kinds...); !reflect.DeepEqual(got, want) {
		t.Errorf("changes\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// On, a namespace's answer has a change of each further source with when, what and who beside the ones it had, whose
// rows and counts are as they were; what a scale by an HPA is listed as is not said twice.
func TestTimelineChangesMore_EachFurtherSourceIsListedBesideTheOthers(t *testing.T) {
	api := moreFixture()
	res := moreRead(t, api)
	wantMoreLines(t, res, []string{
		"-15m0s Job report-29: created by CronJob report",
		"-25m0s NetworkPolicy deny-all: created by kubectl-create",
		"-35m0s Service web: written by kubectl-patch (its manager sets selector; what this write changed is not kept)",
		"-45m0s Deployment web: scaled to 0 by kubectl (a scale keeps no time: when its ReplicaSet's count was set)",
		"-55m0s StatefulSet db: replicas written by kubectl-patch (its manager sets nothing else)",
	}, "Job", "NetworkPolicy", "Service", "Deployment", "StatefulSet")
	by := moreBySource(res)
	for _, source := range timelineMoreChangeSources {
		if by[source] != 1 {
			t.Errorf("by_source.%s = %v, want 1", source, by[source])
		}
	}

	off, err := moreFixture().service(t).GetTimelineChanges(context.Background(), "shop", moreBack(4*time.Hour), moreNow, TimelineChangesMax)
	if err != nil {
		t.Fatal(err)
	}
	kept := []TimelineChange{}
	for _, ch := range res.Changes {
		if slices.ContainsFunc(off.Changes, func(o TimelineChange) bool { return chgJSON(t, o) == chgJSON(t, ch) }) {
			kept = append(kept, ch)
		}
	}
	if len(kept) != len(off.Changes) || len(res.Changes) != len(off.Changes)+5 {
		t.Errorf("%d of the %d changes without the further sources are in the %d with them", len(kept), len(off.Changes), len(res.Changes))
	}
	for source, n := range moreBySource(off) {
		if by[source] != n {
			t.Errorf("by_source.%s = %v, want %v as without the further sources", source, by[source], n)
		}
	}
	if res.Summary["changes_total"] != len(res.Changes) {
		t.Errorf("changes_total %v of %d", res.Summary["changes_total"], len(res.Changes))
	}
}

// On, a namespace costs five lists more, a StatefulSet in it being one of the five; each is asked once, after the
// namespaced sources the view had, as metadata only, and no value of any of them is in the answer.
func TestTimelineChangesMore_TheFurtherListsAreFiveAndMetadataOnly(t *testing.T) {
	api := moreFixture()
	res := moreRead(t, api)
	want := []string{
		"/apis/apps/v1/namespaces/shop/replicasets", "/apis/apps/v1/namespaces/shop/controllerrevisions",
		"/api/v1/namespaces/shop/configmaps", "/api/v1/namespaces/shop/secrets",
		"/apis/autoscaling/v2/namespaces/shop/horizontalpodautoscalers", "/api/v1/namespaces/shop/pods",
		"/apis/batch/v1/namespaces/shop/jobs", "/apis/networking.k8s.io/v1/namespaces/shop/networkpolicies",
		"/api/v1/namespaces/shop/services", "/apis/apps/v1/namespaces/shop/deployments", "/apis/apps/v1/namespaces/shop/statefulsets",
		"/api/v1/nodes", "/apis/argoproj.io/v1alpha1/applications",
	}
	got := []string{}
	for _, ask := range api.paths() {
		got = append(got, ask.path)
		resource := ask.path[strings.LastIndex(ask.path, "/")+1:]
		if _, further := moreKinds[resource]; further && ask.accept != metadataListAccept {
			t.Errorf("%s asked with Accept %q, want metadata only", ask.path, ask.accept)
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("lists\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	answer := chgJSON(t, res)
	for _, value := range []string{"job-spec-value", "policy-spec-value", "service-spec-value", "deployment-spec-value", "secret-value", "configmap-value"} {
		if strings.Contains(answer, value) {
			t.Errorf("the answer holds %q", value)
		}
	}
}

// StatefulSets are listed only where the namespace's revisions name one, so a namespace without one costs four lists;
// when the revisions could not be read they are listed.
func TestTimelineChangesMore_StatefulSetsAreListedOnlyWhereThereMayBeOne(t *testing.T) {
	count := func(api *moreAPI) (further int) {
		moreRead(t, api)
		for _, ask := range api.paths() {
			if _, ok := moreKinds[ask.path[strings.LastIndex(ask.path, "/")+1:]]; ok {
				further++
			}
		}
		return further
	}
	none := moreFixture()
	none.crs = nil
	if n := count(none); n != 4 {
		t.Errorf("%d further lists in a namespace without a StatefulSet, want 4", n)
	}
	unread := moreFixture()
	unread.crs, unread.refuse = nil, map[string]bool{"controllerrevisions": true}
	if n := count(unread); n != 5 {
		t.Errorf("%d further lists when the revisions could not be read, want 5", n)
	}
	if n := count(moreFixture()); n != 5 {
		t.Errorf("%d further lists in a namespace with a StatefulSet, want 5", n)
	}
}

// Without a namespace no further list is asked, by a caller of the whole cluster or of a limited grant: the further
// sources are named as skipped and count null.
func TestTimelineChangesMore_WithoutANamespaceNothingMoreIsRead(t *testing.T) {
	limited := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"shop"}}})
	for name, ctx := range map[string]context.Context{"the cluster": context.Background(), "a limited grant": limited} {
		api := moreFixture()
		res := moreReadIn(t, ctx, api, "")
		for _, ask := range api.paths() {
			if _, further := moreKinds[ask.path[strings.LastIndex(ask.path, "/")+1:]]; further {
				t.Errorf("%s: listed %s", name, ask.path)
			}
		}
		skipped, _ := res.Summary["skipped"].(map[string]string)
		by := moreBySource(res)
		for _, source := range timelineMoreChangeSources {
			if n, named := by[source]; !named || n != nil || skipped[source] != "read in a named namespace only" {
				t.Errorf("%s: by_source.%s = %v, skipped %q, want null and why", name, source, n, skipped[source])
			}
		}
		if by["configmaps"] != 1 || by["rollouts"] != 2 {
			t.Errorf("%s: by_source %v, want the other sources read", name, by)
		}
	}
}

// A kind the caller may not list is named as not readable and counts null; every other source still answers as it does
// with all of them readable.
func TestTimelineChangesMore_ARefusedKindIsNotReadableAndTheRestAnswers(t *testing.T) {
	whole := moreRead(t, moreFixture())
	kindOf := map[string]string{"jobs": "Job", "networkpolicies": "NetworkPolicy", "services": "Service", "deployment_replicas": "Deployment", "statefulset_replicas": "StatefulSet"}
	listOf := map[string]string{"deployment_replicas": "deployments", "statefulset_replicas": "statefulsets"}
	for _, source := range timelineMoreChangeSources {
		resource := source
		if r := listOf[source]; r != "" {
			resource = r
		}
		api := moreFixture()
		api.refuse = map[string]bool{resource: true}
		res := moreRead(t, api)
		notRead, _ := res.Summary["not_read"].(map[string]string)
		if want := "not readable: list " + resource + ": " + resource + " is forbidden"; len(notRead) != 1 || notRead[source] != want {
			t.Errorf("%s: not_read %v, want %q", source, notRead, want)
		}
		by := moreBySource(res)
		if n, named := by[source]; !named || n != nil {
			t.Errorf("by_source.%s = %v, want null", source, n)
		}
		for other, n := range moreBySource(whole) {
			if other != source && by[other] != n {
				t.Errorf("%s refused: by_source.%s = %v, want %v", source, other, by[other], n)
			}
		}
		want := []string{}
		for _, ch := range whole.Changes {
			if ch.Kind != kindOf[source] || ch.What == "rollout" {
				want = append(want, moreLine(ch))
			}
		}
		got := []string{}
		for _, ch := range res.Changes {
			got = append(got, moreLine(ch))
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s refused: changes\n%s\nwant\n%s", source, strings.Join(got, "\n"), strings.Join(want, "\n"))
		}
	}

	all := moreFixture()
	all.refuse = map[string]bool{"replicasets": true, "configmaps": true, "secrets": true, "horizontalpodautoscalers": true, "pods": true}
	for resource := range moreKinds {
		all.refuse[resource] = true
	}
	if _, err := all.service(t).GetTimelineChangesMore(context.Background(), "shop", moreBack(4*time.Hour), moreNow, TimelineChangesMax); !apierrors.IsForbidden(err) {
		t.Errorf("every source refused: %v, want the refusal", err)
	}
}

// A Job counts by when it was made: one before the window, after it or in the future is none. It says which CronJob's
// run it is, the other controller or the field manager that made it, a run by hand, and a status with no start time.
func TestTimelineChangesMore_JobsMadeInTheWindowSayWhatMadeThem(t *testing.T) {
	started := func(at time.Time) metav1.ManagedFieldsEntry {
		return moreWrite("kube-controller-manager", "status", at, `{"f:status":{"f:startTime":{},"f:active":{}}}`)
	}
	job := func(name string, age time.Duration, owner []metav1.OwnerReference, entries ...metav1.ManagedFieldsEntry) moreObject {
		return moreObject{meta: metav1.ObjectMeta{Name: name, Namespace: "shop", CreationTimestamp: metav1.NewTime(moreBack(age)), OwnerReferences: owner, ManagedFields: entries}}
	}
	byHand := job("report-manual-1", 50*time.Minute, chgOwner("CronJob", "report"), started(moreBack(49*time.Minute)))
	byHand.meta.Annotations = map[string]string{"cronjob.kubernetes.io/instantiate": "manual"}
	elsewhere := job("elsewhere", time.Hour, nil)
	elsewhere.meta.Namespace = "billing"
	api := &moreAPI{objects: map[string][]moreObject{"jobs": {
		job("report-1", 5*time.Hour, chgOwner("CronJob", "report"), started(moreBack(time.Minute))),
		job("before", 4*time.Hour+time.Second, nil),
		job("first-second", 4*time.Hour, nil),
		job("report-2", 2*time.Hour, chgOwner("CronJob", "report"), started(moreBack(2*time.Hour))),
		byHand,
		job("step-1", 40*time.Minute, chgOwner("Workflow", "etl"), started(moreBack(39*time.Minute))),
		job("migrate", 30*time.Minute, nil, moreWrite("kubectl-create", "", moreBack(30*time.Minute), `{"f:spec":{"f:template":{}}}`),
			moreWrite("kubectl-label", "", moreBack(time.Minute), `{"f:metadata":{"f:labels":{}}}`), started(moreBack(29*time.Minute))),
		job("held", 20*time.Minute, nil, moreWrite("helm", "", moreBack(20*time.Minute), `{"f:spec":{"f:suspend":{}}}`),
			moreWrite("kube-controller-manager", "status", moreBack(19*time.Minute), `{"f:status":{"f:conditions":{}}}`)),
		job("later", -time.Minute, nil),
		elsewhere,
	}}}
	res := moreRead(t, api)
	wantMoreLines(t, res, []string{
		"-20m0s Job held: created by helm (its status has no start time)",
		"-30m0s Job migrate: created by kubectl-create",
		"-40m0s Job step-1: created by Workflow etl",
		"-50m0s Job report-manual-1: created by CronJob report (run by hand)",
		"-2h0m0s Job report-2: created by CronJob report",
		"-4h0m0s Job first-second: created",
	}, "Job")
	if by := moreBySource(res); by["jobs"] != 6 {
		t.Errorf("by_source.jobs = %v, want 6", by["jobs"])
	}
}

// A batch of Jobs leaves room for the other changes: the newest four of a CronJob and the newest fifteen of all are
// listed, every one is counted, and a CronJob's newest says how many it made.
func TestTimelineChangesMore_ManyJobsAreCountedAndTheNewestListed(t *testing.T) {
	api := moreFixture()
	api.objects["jobs"] = nil
	for i := 0; i < 200; i++ {
		api.objects["jobs"] = append(api.objects["jobs"], moreObject{meta: metav1.ObjectMeta{Name: fmt.Sprintf("tick-%03d", i), Namespace: "shop",
			CreationTimestamp: metav1.NewTime(moreBack(time.Duration(i+1) * time.Minute)), OwnerReferences: chgOwner("CronJob", "tick")}})
	}
	for i := 0; i < 40; i++ {
		api.objects["jobs"] = append(api.objects["jobs"], moreObject{meta: metav1.ObjectMeta{Name: fmt.Sprintf("batch-%03d", i), Namespace: "shop",
			CreationTimestamp: metav1.NewTime(moreBack(time.Duration(i)*time.Minute + 30*time.Second))}})
	}
	res := moreRead(t, api)
	jobs := chgOfKind(res, "Job")
	ticks := []string{}
	for _, ch := range jobs {
		if ch.By == "CronJob tick" {
			ticks = append(ticks, ch.Name)
		}
	}
	if len(jobs) != 15 || !reflect.DeepEqual(ticks, []string{"tick-000", "tick-001", "tick-002", "tick-003"}) {
		t.Errorf("%d Jobs listed, the CronJob's %v, want 15 and its newest 4", len(jobs), ticks)
	}
	if i := slices.IndexFunc(jobs, func(ch TimelineChange) bool { return ch.Name == "tick-000" }); i < 0 ||
		jobs[i].Note != "200 Jobs of this CronJob in the window, the first at 2026-11-25T06:40:00Z; at most the newest 4 are listed" {
		t.Errorf("the CronJob's newest: %+v", jobs)
	}
	if by := moreBySource(res); by["jobs"] != 240 || by["rollouts"] != 2 || by["pods"] != 1 {
		t.Errorf("by_source %v, want the 240 Jobs counted", moreBySource(res))
	}
	if len(res.Changes) >= TimelineChangesMax || res.Summary["changes_total"] != len(res.Changes)+225 {
		t.Errorf("%d listed of %v, want the 225 Jobs left out counted", len(res.Changes), res.Summary["changes_total"])
	}
}

// A NetworkPolicy is a change when a manager that sets its spec wrote it in the window, a Service when one that sets its
// ports or selector did; a write of labels, status or another field is none. An entry from a clock ahead is left out
// and does not hide the one before it.
func TestTimelineChangesMore_PoliciesAndServicesAreWritesOfTheirSpec(t *testing.T) {
	month := moreBack(30 * 24 * time.Hour)
	object := func(name string, created time.Time, entries ...metav1.ManagedFieldsEntry) moreObject {
		return moreObject{meta: metav1.ObjectMeta{Name: name, Namespace: "shop", CreationTimestamp: metav1.NewTime(created), ManagedFields: entries}}
	}
	ports := `{"f:spec":{"f:ports":{".":{},"k:{\"port\":80,\"protocol\":\"TCP\"}":{"f:targetPort":{}}},"f:selector":{},"f:type":{}}}`
	noFields := moreWrite("kubectl-edit", "", moreBack(time.Hour), "")
	noFields.FieldsV1 = nil
	api := &moreAPI{objects: map[string][]moreObject{
		"networkpolicies": {
			object("edited", month, moreWrite("kubectl-create", "", month, `{"f:spec":{"f:ingress":{},"f:podSelector":{},"f:policyTypes":{}}}`),
				moreWrite("kubectl-edit", "", moreBack(10*time.Minute), `{"f:spec":{"f:egress":{},"f:policyTypes":{}}}`)),
			object("labelled", month, moreWrite("kubectl-label", "", moreBack(11*time.Minute), `{"f:metadata":{"f:labels":{}}}`)),
			object("old", month, moreWrite("kubectl-edit", "", moreBack(4*time.Hour+time.Minute), `{"f:spec":{"f:egress":{}}}`)),
			object("ahead", month, moreWrite("argocd-controller", "", moreBack(12*time.Minute), `{"f:spec":{"f:ingress":{}}}`),
				moreWrite("kubectl-edit", "", moreBack(-5*time.Minute), `{"f:spec":{"f:ingress":{}}}`)),
			object("only-ahead", month, moreWrite("kubectl-edit", "", moreBack(-time.Hour), `{"f:spec":{"f:ingress":{}}}`)),
			object("no-fields", month, noFields),
			object("made-ahead", moreBack(-time.Minute)),
			object("made-unmanaged", moreBack(13*time.Minute)),
		},
		"services": {
			object("ports-and-selector", month, moreWrite("helm", "", moreBack(20*time.Minute), ports)),
			object("type-only", month, moreWrite("kubectl-patch", "", moreBack(21*time.Minute), `{"f:spec":{"f:type":{}}}`)),
			object("status", month, moreWrite("aws-load-balancer-controller", "status", moreBack(22*time.Minute), `{"f:status":{"f:loadBalancer":{}},"f:spec":{"f:ports":{}}}`)),
			object("annotated", month, moreWrite("controller", "", moreBack(23*time.Minute), `{"f:metadata":{"f:annotations":{}}}`)),
			object("made", moreBack(24*time.Minute), moreWrite("kubectl-create", "", moreBack(24*time.Minute), ports)),
			object("made-then-patched", moreBack(2*time.Hour), moreWrite("kubectl-create", "", moreBack(2*time.Hour), ports),
				moreWrite("rollouts-controller", "", moreBack(25*time.Minute), `{"f:spec":{"f:selector":{}}}`)),
			object("selector-ahead", month, moreWrite("kubectl-patch", "", moreBack(-time.Second), `{"f:spec":{"f:selector":{}}}`)),
		},
	}}
	wantMoreLines(t, moreRead(t, api), []string{
		"-10m0s NetworkPolicy edited: written by kubectl-edit (its manager sets egress, policyTypes; what this write changed is not kept)",
		"-12m0s NetworkPolicy ahead: written by argocd-controller (its manager sets ingress; what this write changed is not kept)",
		"-13m0s NetworkPolicy made-unmanaged: created",
		"-20m0s Service ports-and-selector: written by helm (its manager sets ports, selector; what this write changed is not kept)",
		"-24m0s Service made: created by kubectl-create",
		"-25m0s Service made-then-patched: written by rollouts-controller (its manager sets selector; what this write changed is not kept)",
	}, "NetworkPolicy", "Service")
}

// A workload's replica count is a change when a manager that sets it wrote in the window: alone, or among other fields
// with no revision made then. A creation, a rollout, another field and an entry from a clock ahead are none.
func TestTimelineChangesMore_ReplicaCountsWritten(t *testing.T) {
	api := moreReplicas()
	res := moreRead(t, api)
	wantMoreLines(t, res, []string{
		"-33m0s Deployment edited: replicas written by kubectl-edit (its manager sets nothing else)",
		"-34m0s Deployment beside-rollout: written by kubectl-patch (its manager sets replicas; what this write changed is not kept)",
		"-40m0s Deployment gitops: written by argocd-controller (its manager sets replicas; what this write changed is not kept; 3 replicas now)",
		"-45m0s Deployment timed: scaled by keda",
		"-46m0s Deployment both: replicas written to 4 by kubectl-patch (its manager sets nothing else)",
		"-48m0s StatefulSet db: replicas written by kubectl-edit (its manager sets nothing else)",
		"-49m0s StatefulSet cache: written by helm (its manager sets replicas; what this write changed is not kept)",
	}, "Deployment", "StatefulSet")
	if by := moreBySource(res); by["deployment_replicas"] != 5 || by["statefulset_replicas"] != 2 {
		t.Errorf("by_source %v, want 5 and 2", by)
	}

	// when the rollouts could not be read, a write of other fields too is said: no revision rules it out, and no count is kept
	api = moreReplicas()
	api.refuse = map[string]bool{"replicasets": true}
	wantMoreLines(t, moreRead(t, api), []string{
		"-33m0s Deployment edited: replicas written by kubectl-edit (its manager sets nothing else)",
		"-34m0s Deployment beside-rollout: written by kubectl-patch (its manager sets replicas; what this write changed is not kept)",
		"-40m0s Deployment gitops: written by argocd-controller (its manager sets replicas; what this write changed is not kept)",
		"-41m0s Deployment released: written by helm (its manager sets replicas; what this write changed is not kept)",
		"-45m0s Deployment timed: scaled by keda",
		"-46m0s Deployment both: replicas written by kubectl-patch (its manager sets nothing else)",
	}, "Deployment")
}

// moreReplicas is a namespace of workloads whose replica count was, or was not, written in the window.
func moreReplicas() *moreAPI {
	month := moreBack(30 * 24 * time.Hour)
	rs := func(name, deployment, revision string, at time.Time, desired string) appsv1.ReplicaSet {
		r := chgReplicaSet("shop", name, deployment, revision, at, "img:"+revision)
		if desired != "" {
			r.Annotations[desiredReplicasAnnotation] = desired
		}
		return r
	}
	cr := appsv1.ControllerRevision{ObjectMeta: metav1.ObjectMeta{Name: "db-1", Namespace: "shop", CreationTimestamp: metav1.NewTime(month), OwnerReferences: chgOwner("StatefulSet", "db")},
		Revision: 1, Data: runtime.RawExtension{Raw: []byte(`{}`)}}
	return &moreAPI{
		changesAPI: changesAPI{
			rs: []appsv1.ReplicaSet{
				rs("gitops-1", "gitops", "1", month, "3"),
				rs("released-1", "released", "1", month, "2"), rs("released-2", "released", "2", moreBack(41*time.Minute-3*time.Second), "2"),
				rs("made-1", "made", "1", moreBack(42*time.Minute), "1"),
				rs("beside-rollout-1", "beside-rollout", "1", month, ""), rs("beside-rollout-2", "beside-rollout", "2", moreBack(34*time.Minute-2*time.Second), ""),
				rs("both-9", "both", "9", moreBack(9*24*time.Hour), "6"), rs("both-10", "both", "10", moreBack(8*24*time.Hour), "4"), rs("both-8", "both", "8", month, "7"),
				rs("unsaid-1", "timed", "1", month, "x"),
			},
			crs: []appsv1.ControllerRevision{cr},
		},
		objects: map[string][]moreObject{
			"deployments": {
				moreWorkload("edited", month, moreWrite("kubectl-edit", "", moreBack(33*time.Minute), moreScaleFields)),
				moreWorkload("gitops", month, moreWrite("argocd-controller", "", moreBack(40*time.Minute), moreApplyFields)),
				moreWorkload("released", month, moreWrite("helm", "", moreBack(41*time.Minute), moreApplyFields)),
				moreWorkload("beside-rollout", month, moreWrite("kubectl-patch", "", moreBack(34*time.Minute), `{"f:spec":{"f:replicas":{},"f:strategy":{}}}`)),
				moreWorkload("made", moreBack(42*time.Minute), moreWrite("kubectl-create", "", moreBack(42*time.Minute), moreApplyFields)),
				moreWorkload("image", month, moreWrite("kubectl-set", "", moreBack(43*time.Minute), `{"f:spec":{"f:template":{}}}`)),
				moreWorkload("status", month, moreWrite("kube-controller-manager", "status", moreBack(44*time.Minute), `{"f:status":{"f:replicas":{}},"f:spec":{"f:replicas":{}}}`)),
				moreWorkload("timed", month, moreWrite("keda", "scale", moreBack(45*time.Minute), moreScaleFields), moreWrite("kubectl-edit", "", moreBack(-time.Minute), moreScaleFields)),
				moreWorkload("only-ahead", month, moreWrite("kubectl-edit", "", moreBack(-time.Hour), moreScaleFields)),
				moreWorkload("old", month, moreWrite("kubectl-edit", "", moreBack(5*time.Hour), moreScaleFields)),
				moreWorkload("both", month, moreWrite("helm", "", moreBack(47*time.Minute), moreApplyFields), moreWrite("kubectl-patch", "", moreBack(46*time.Minute), moreScaleFields)),
			},
			"statefulsets": {
				moreWorkload("db", month, moreWrite("kubectl-edit", "", moreBack(48*time.Minute), moreScaleFields)),
				moreWorkload("cache", month, moreWrite("helm", "", moreBack(49*time.Minute), moreApplyFields)),
				moreWorkload("scaled", month, moreScale("kubectl")),
			},
		},
	}
}

func moreWorkload(name string, created time.Time, entries ...metav1.ManagedFieldsEntry) moreObject {
	return moreObject{meta: metav1.ObjectMeta{Name: name, Namespace: "shop", CreationTimestamp: metav1.NewTime(created), ManagedFields: entries}}
}

// A scale through the scale subresource keeps who and no time. It is listed when the Deployment's newest ReplicaSet says
// its count was set in the window, by a rollout or another write of the Deployment aside, and not where its HPA's row
// says it already. Without a time to place it, it is not listed.
func TestTimelineChangesMore_AScaleIsWhenItsReplicaSetsCountWasSet(t *testing.T) {
	month, week := moreBack(30*24*time.Hour), moreBack(7*24*time.Hour)
	annotated := `{"f:metadata":{"f:annotations":{"f:team":{}}}}`
	scaled, long := metav1.NewTime(moreBack(31*time.Minute)), metav1.NewTime(moreBack(6*time.Hour))
	hpa := func(kind, name string, at *metav1.Time) autoscalingv2.HorizontalPodAutoscaler {
		return autoscalingv2.HorizontalPodAutoscaler{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "shop"},
			Spec:   autoscalingv2.HorizontalPodAutoscalerSpec{ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{Kind: kind, Name: name}},
			Status: autoscalingv2.HorizontalPodAutoscalerStatus{LastScaleTime: at}}
	}
	api := &moreAPI{objects: map[string][]moreObject{}}
	// a Deployment, its ReplicaSets as (made, count set), the newest first, and the entries beside the scale's
	type set struct{ made, set time.Time }
	add := func(name, manager string, sets []set, entries ...metav1.ManagedFieldsEntry) {
		for i, at := range sets {
			r := chgReplicaSet("shop", fmt.Sprintf("%s-%d", name, i), name, strconv.Itoa(len(sets)-i), at.made, "img")
			r.Annotations[desiredReplicasAnnotation] = strconv.Itoa(i)
			api.rs = append(api.rs, moreCounted(r, at.set))
		}
		api.objects["deployments"] = append(api.objects["deployments"], moreWorkload(name, month, append(entries, moreScale(manager))...))
	}
	add("stopped", "kubectl", []set{{week, moreBack(30 * time.Minute)}, {month, week}},
		moreWrite("kube-controller-manager", "status", moreBack(30*time.Minute), `{"f:status":{"f:replicas":{}}}`))
	add("listed-hpa", "kube-controller-manager", []set{{week, moreBack(31 * time.Minute)}})
	add("old-hpa", "kube-controller-manager", []set{{week, moreBack(32 * time.Minute)}})
	add("by-hand", "kubectl", []set{{week, moreBack(31*time.Minute + 30*time.Second)}})
	add("rolling", "kubectl", []set{{moreBack(50 * time.Minute), moreBack(36 * time.Minute)}, {month, moreBack(36*time.Minute + 20*time.Second)}})
	add("rolled-down-last", "kubectl", []set{{moreBack(50 * time.Minute), moreBack(38 * time.Minute)}, {month, moreBack(37 * time.Minute)}})
	add("just-made", "kubectl", []set{{moreBack(39*time.Minute + 30*time.Second), moreBack(39 * time.Minute)}})
	add("annotated", "kubectl", []set{{week, moreBack(40 * time.Minute)}}, moreWrite("kubectl-annotate", "", moreBack(40*time.Minute+5*time.Second), annotated))
	add("annotated-before", "kubectl", []set{{week, moreBack(41 * time.Minute)}}, moreWrite("kubectl-annotate", "", moreBack(50*time.Minute), annotated))
	add("ahead", "kubectl", []set{{week, moreBack(-time.Minute)}})
	add("before", "kubectl", []set{{week, moreBack(4*time.Hour + time.Minute)}})
	api.objects["deployments"] = append(api.objects["deployments"], moreWorkload("no-replicaset", month, moreScale("kubectl")))
	api.hpas = []autoscalingv2.HorizontalPodAutoscaler{hpa("Deployment", "listed-hpa", &scaled), hpa("Deployment", "old-hpa", &long), hpa("StatefulSet", "by-hand", &scaled)}

	const when = " (a scale keeps no time: when its ReplicaSet's count was set)"
	res := moreRead(t, api)
	wantMoreLines(t, res, []string{
		"-30m0s Deployment stopped: scaled to 0 by kubectl" + when,
		"-31m30s Deployment by-hand: scaled to 0 by kubectl" + when,
		"-32m0s Deployment old-hpa: scaled to 0 by kube-controller-manager" + when,
		"-41m0s Deployment annotated-before: scaled to 0 by kubectl" + when,
	}, "Deployment")
	if by := moreBySource(res); by["deployment_replicas"] != 4 {
		t.Errorf("by_source.deployment_replicas = %v, want 4", by["deployment_replicas"])
	}

	// the ReplicaSets read in another order, a page at a time, say the same
	slices.Reverse(api.rs)
	api.pageSize = 3
	if again := moreRead(t, api); chgJSON(t, again.Changes) != chgJSON(t, res.Changes) {
		t.Errorf("in another order\n%s\nwant\n%s", chgJSON(t, again.Changes), chgJSON(t, res.Changes))
	}

	// without the ReplicaSets nothing says when
	api.refuse = map[string]bool{"replicasets": true}
	if lines := moreLines(moreRead(t, api), "Deployment"); len(lines) != 0 {
		t.Errorf("without the ReplicaSets: %s", strings.Join(lines, "\n"))
	}
}

// The field manager client-go runs as the API server does writes the entries the sources read: a Service's selector and
// a policy's rules by the manager that set them alone, a count by its own, and a label by none of them.
func TestTimelineChangesMore_TheEntriesAreThoseTheFieldManagerWrites(t *testing.T) {
	ctx, cs := context.Background(), fake.NewClientset()
	month := metav1.NewTime(time.Now().Add(-30 * 24 * time.Hour))
	meta := metav1.ObjectMeta{Name: "web", Namespace: "shop", CreationTimestamp: month}
	by := func(manager string) metav1.UpdateOptions { return metav1.UpdateOptions{FieldManager: manager} }
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	svc, err := cs.CoreV1().Services("shop").Create(ctx, &corev1.Service{ObjectMeta: meta, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "web"}, Ports: []corev1.ServicePort{{Port: 80}}}}, metav1.CreateOptions{FieldManager: "helm"})
	must(err)
	svc.Spec.Selector = map[string]string{"app": "other"}
	svc, err = cs.CoreV1().Services("shop").Update(ctx, svc, by("kubectl-patch"))
	must(err)
	svc.Labels = map[string]string{"team": "a"}
	svc, err = cs.CoreV1().Services("shop").Update(ctx, svc, by("kubectl-label"))
	must(err)
	np, err := cs.NetworkingV1().NetworkPolicies("shop").Create(ctx, &networkingv1.NetworkPolicy{ObjectMeta: meta, Spec: networkingv1.NetworkPolicySpec{PolicyTypes: []networkingv1.PolicyType{"Ingress"}}}, metav1.CreateOptions{FieldManager: "helm"})
	must(err)
	np.Spec.Egress = []networkingv1.NetworkPolicyEgressRule{{}}
	np, err = cs.NetworkingV1().NetworkPolicies("shop").Update(ctx, np, by("kubectl-edit"))
	must(err)
	three, none := int32(3), int32(0)
	labels := metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}
	tmpl := corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels.MatchLabels}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "web", Image: "web:1"}}}}
	d, err := cs.AppsV1().Deployments("shop").Create(ctx, &appsv1.Deployment{ObjectMeta: meta, Spec: appsv1.DeploymentSpec{Replicas: &three, Selector: &labels, Template: tmpl}}, metav1.CreateOptions{FieldManager: "helm"})
	must(err)
	d.Spec.Replicas = &none
	d, err = cs.AppsV1().Deployments("shop").Update(ctx, d, by("kubectl-edit"))
	must(err)
	rs, err := cs.AppsV1().ReplicaSets("shop").Create(ctx, &appsv1.ReplicaSet{ObjectMeta: meta, Spec: appsv1.ReplicaSetSpec{Replicas: &three, Selector: &labels, Template: tmpl}}, metav1.CreateOptions{FieldManager: "kube-controller-manager"})
	must(err)
	rs.Spec.Replicas = &none
	rs, err = cs.AppsV1().ReplicaSets("shop").Update(ctx, rs, by("kube-controller-manager"))
	must(err)

	sink := newChangeSink(time.Now().Add(-time.Hour), time.Now(), TimelineChangesMax)
	sink.more = &moreChanges{}
	ch, ok := specChange("Service", &svc.ObjectMeta, []string{"ports", "selector"}, sink)
	if !ok || ch.What != "written" || ch.By != "kubectl-patch" || ch.Note != "its manager sets selector; what this write changed is not kept" {
		t.Errorf("service %v %+v", ok, ch)
	}
	ch, ok = specChange("NetworkPolicy", &np.ObjectMeta, nil, sink)
	if !ok || ch.What != "written" || ch.By != "kubectl-edit" || ch.Note != "its manager sets egress; what this write changed is not kept" {
		t.Errorf("policy %v %+v", ok, ch)
	}
	ch, ok = replicaChange("Deployment", &d.ObjectMeta, sink)
	if !ok || ch.What != "replicas written" || ch.By != "kubectl-edit" {
		t.Errorf("deployment %v %+v", ok, ch)
	}
	if set := newRevisionBook(sink.since, sink.until).countSet(&rs.ObjectMeta, 0); set.IsZero() || set.Before(sink.since) {
		t.Errorf("the ReplicaSet's count set at %s", set)
	}
}

// A manager that sets an object's spec and its labels too (helm, kubectl apply) writes it when it changes a label alone:
// the entry's time is that write's, so the row says what the manager sets and that what changed is not kept, also where
// that is one field. A label written by a manager that sets no field of the spec is no change.
func TestTimelineChangesMore_AWriteSaysWhatItChangedIsNotKept(t *testing.T) {
	ctx, cs := context.Background(), fake.NewClientset()
	meta := metav1.ObjectMeta{Name: "web", Namespace: "shop", CreationTimestamp: metav1.NewTime(time.Now().Add(-30 * 24 * time.Hour)), Labels: map[string]string{"chart": "web-1"}}
	by := func(manager string) metav1.UpdateOptions { return metav1.UpdateOptions{FieldManager: manager} }
	create := metav1.CreateOptions{FieldManager: "helm"}
	ports := []corev1.ServicePort{{Port: 80}}
	both, err := cs.CoreV1().Services("shop").Create(ctx, &corev1.Service{ObjectMeta: meta, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "web"}, Ports: ports}}, create)
	if err != nil {
		t.Fatal(err)
	}
	meta.Name = "headless"
	one, err := cs.CoreV1().Services("shop").Create(ctx, &corev1.Service{ObjectMeta: meta, Spec: corev1.ServiceSpec{Ports: ports}}, create)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := cs.NetworkingV1().NetworkPolicies("shop").Create(ctx, &networkingv1.NetworkPolicy{ObjectMeta: meta, Spec: networkingv1.NetworkPolicySpec{PolicyTypes: []networkingv1.PolicyType{"Ingress"}}}, create)
	if err != nil {
		t.Fatal(err)
	}

	time.Sleep(10 * time.Millisecond)
	sink := newChangeSink(time.Now(), time.Now().Add(time.Hour), TimelineChangesMax) // after they were made
	if _, ok := specChange("Service", &both.ObjectMeta, []string{"ports", "selector"}, sink); ok {
		t.Fatal("the creation is in the window")
	}
	both.Labels, one.Labels, policy.Labels = map[string]string{"chart": "web-2"}, map[string]string{"chart": "web-2"}, map[string]string{"chart": "web-2"}
	if both, err = cs.CoreV1().Services("shop").Update(ctx, both, by("helm")); err != nil {
		t.Fatal(err)
	}
	if one, err = cs.CoreV1().Services("shop").Update(ctx, one, by("kubectl-label")); err != nil {
		t.Fatal(err)
	}
	if ch, ok := specChange("Service", &one.ObjectMeta, []string{"ports", "selector"}, sink); ok {
		t.Errorf("a label written by a manager of labels alone: %+v", ch)
	}
	one.Labels = map[string]string{"chart": "web-3"}
	if one, err = cs.CoreV1().Services("shop").Update(ctx, one, by("helm")); err != nil {
		t.Fatal(err)
	}
	if policy, err = cs.NetworkingV1().NetworkPolicies("shop").Update(ctx, policy, by("helm")); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		kind   string
		meta   *metav1.ObjectMeta
		fields []string
		note   string
	}{
		{"Service", &both.ObjectMeta, []string{"ports", "selector"}, "its manager sets ports, selector; what this write changed is not kept"},
		{"Service", &one.ObjectMeta, []string{"ports", "selector"}, "its manager sets ports; what this write changed is not kept"},
		{"NetworkPolicy", &policy.ObjectMeta, nil, "its manager sets policyTypes; what this write changed is not kept"},
	} {
		if ch, ok := specChange(c.kind, c.meta, c.fields, sink); !ok || ch.What != "written" || ch.By != "helm" || ch.Note != c.note {
			t.Errorf("%s %s: %v %+v, want note %q", c.kind, c.meta.Name, ok, ch, c.note)
		}
	}
}

// The last count a rollout sets on the new ReplicaSet can come long after the old one's: where the old pods are waited for
// until they have ended (their termination grace), and where the old ReplicaSet is kept no more. Neither is a scale; a
// count set after the rollout's end is one.
func TestTimelineChangesMore_TheEndOfASlowRolloutIsNotAScale(t *testing.T) {
	month := moreBack(30 * 24 * time.Hour)
	rs := func(deployment, revision string, made, set time.Time, grace int64) appsv1.ReplicaSet {
		r := moreCounted(chgReplicaSet("shop", deployment+"-"+revision, deployment, revision, made, "img:"+revision), set)
		if grace > 0 {
			r.Spec.Template.Spec.TerminationGracePeriodSeconds = &grace
		}
		return r
	}
	min := func(n float64) time.Time { return moreBack(time.Duration(n * float64(time.Minute))) }
	for _, c := range []struct {
		name string
		rs   []appsv1.ReplicaSet
		want bool
	}{
		// the old pods took their eight of ten minutes to end, then the new ReplicaSet was filled
		{"waited for ten minutes' grace", []appsv1.ReplicaSet{rs("web", "1", month, min(40), 600), rs("web", "2", min(50), min(32), 30)}, false},
		{"the same in the other order", []appsv1.ReplicaSet{rs("web", "2", min(50), min(32), 30), rs("web", "1", month, min(40), 600)}, false},
		{"the grace of one before the last", []appsv1.ReplicaSet{rs("web", "1", month, min(40), 600), rs("web", "2", min(60), min(39.5), 30), rs("web", "3", min(50), min(32), 30)}, false},
		{"after the grace and a minute", []appsv1.ReplicaSet{rs("web", "1", month, min(40), 600), rs("web", "2", min(50), min(28), 30)}, true},
		{"a grace not given is thirty seconds", []appsv1.ReplicaSet{rs("web", "1", month, min(40), 0), rs("web", "2", min(50), min(38.6), 0)}, false},
		{"past it", []appsv1.ReplicaSet{rs("web", "1", month, min(40), 0), rs("web", "2", min(50), min(38), 0)}, true},
		{"the new one's grace does not count", []appsv1.ReplicaSet{rs("web", "1", month, min(40), 30), rs("web", "2", min(50), min(32), 600)}, true},
		{"an older one's count set before the window, its grace ending in it", []appsv1.ReplicaSet{rs("web", "1", month, min(243), 600), rs("web", "2", min(250), min(235), 30)}, false},
		// nothing of the old one is kept (revisionHistoryLimit 0)
		{"no older one, made in the window", []appsv1.ReplicaSet{rs("web", "2", min(50), min(32), 30)}, false},
		{"no older one, made before the window", []appsv1.ReplicaSet{rs("web", "2", min(250), min(32), 30)}, true},
		{"the first revision", []appsv1.ReplicaSet{rs("web", "1", min(50), min(32), 30)}, true},
	} {
		api := &moreAPI{changesAPI: changesAPI{rs: c.rs}, objects: map[string][]moreObject{"deployments": {moreWorkload("web", month, moreScale("kubectl"))}}}
		lines := moreLines(moreRead(t, api), "Deployment")
		if got := len(lines) == 1 && strings.Contains(lines[0], "scaled by kubectl"); got != c.want || len(lines) > 1 {
			t.Errorf("%s: %q, want a scale %v", c.name, lines, c.want)
		}
	}
}

// A manager whose only spec field is the replica count can write a label: by server-side apply of both, by an update, or
// by an apply that gives a field of its own up. The count is said to be what was written only of a manager that sets
// nothing else by update; every other row says that what the write changed is not kept.
func TestTimelineChangesMore_AWriteOfALabelIsNotSaidToBeOfTheCount(t *testing.T) {
	ctx, cs := context.Background(), fake.NewClientset()
	deployments := cs.AppsV1().Deployments("shop")
	three := int32(3)
	labels := metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}
	tmpl := corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels.MatchLabels}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "web", Image: "web:1"}}}}
	month := metav1.NewTime(time.Now().Add(-30 * 24 * time.Hour))
	made := func(name string) {
		t.Helper()
		d := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "shop", CreationTimestamp: month}, Spec: appsv1.DeploymentSpec{Selector: &labels, Template: tmpl}}
		if _, err := deployments.Create(ctx, d, metav1.CreateOptions{FieldManager: "helm"}); err != nil {
			t.Fatal(err)
		}
	}
	apply := func(name string, replicas int32, team string) {
		t.Helper()
		ac := applyappsv1.Deployment(name, "shop").WithSpec(applyappsv1.DeploymentSpec().WithReplicas(replicas))
		if team != "" {
			ac.WithLabels(map[string]string{"team": team})
		}
		if _, err := deployments.Apply(ctx, ac, metav1.ApplyOptions{FieldManager: "scaler", Force: true}); err != nil {
			t.Fatal(err)
		}
	}
	edit := func(name string, change func(*appsv1.Deployment)) {
		t.Helper()
		d, err := deployments.Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		change(d)
		if _, err := deployments.Update(ctx, d, metav1.UpdateOptions{FieldManager: "kubectl-edit"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"applied", "edited", "given-up", "counted", "count-applied"} {
		made(name)
	}
	apply("applied", 3, "a")
	apply("given-up", 3, "a")
	edit("edited", func(d *appsv1.Deployment) { d.Spec.Replicas = &three })

	time.Sleep(10 * time.Millisecond)
	sink := newChangeSink(time.Now(), time.Now().Add(time.Hour), TimelineChangesMax) // after the counts were set
	sink.more = &moreChanges{}
	apply("applied", 3, "b")                                                                  // the label alone
	edit("edited", func(d *appsv1.Deployment) { d.Labels = map[string]string{"team": "b"} })  // the label alone
	apply("given-up", 3, "")                                                                  // the label given up
	edit("counted", func(d *appsv1.Deployment) { four := int32(4); d.Spec.Replicas = &four }) // the count
	apply("count-applied", 5, "")                                                             // the count
	for name, want := range map[string]string{
		"applied":       "written by scaler (its manager sets replicas; what this write changed is not kept)",
		"edited":        "written by kubectl-edit (its manager sets replicas; what this write changed is not kept)",
		"given-up":      "written by scaler (its manager sets replicas; what this write changed is not kept)",
		"counted":       "replicas written by kubectl-edit (its manager sets nothing else)",
		"count-applied": "written by scaler (its manager sets replicas; what this write changed is not kept)",
	} {
		d, err := deployments.Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		ch, ok := replicaChange("Deployment", &d.ObjectMeta, sink)
		if got := fmt.Sprintf("%s by %s (%s)", ch.What, ch.By, ch.Note); !ok || got != want {
			t.Errorf("%s: %v %q, want %q; entries %s", name, ok, got, want, chgJSON(t, d.ManagedFields))
		}
	}
}

// Read a page at a time, the further lists are read to their end, one after another, holding at most one of
// bigReadSlots and none after.
func TestTimelineChangesMore_EveryPageIsReadHoldingOnePlace(t *testing.T) {
	api := moreFixture()
	api.pageSize = 2
	for resource, kind := range moreKinds {
		for i := 0; i < 4; i++ {
			api.objects[resource] = append(api.objects[resource], moreObject{meta: metav1.ObjectMeta{Name: fmt.Sprintf("%s-%d", strings.ToLower(kind.kind), i), Namespace: "shop"}})
		}
	}
	res := moreRead(t, api)
	pages := map[string]int{}
	for _, ask := range api.paths() {
		pages[ask.path[strings.LastIndex(ask.path, "/")+1:]]++
	}
	for resource := range moreKinds {
		if want := 3; pages[resource] != want {
			t.Errorf("%s read in %d pages, want %d", resource, pages[resource], want)
		}
	}
	if by := moreBySource(res); by["jobs"] != 1 || by["services"] != 1 {
		t.Errorf("by_source %v", by)
	}
	if api.inUse != 1 || bigReadSlots.InUse() != 0 {
		t.Errorf("at most %d places held at once and %d after, want one and none", api.inUse, bigReadSlots.InUse())
	}
}

// The same window asked with and without the further sources at one moment is two reads: neither gets the other's answer.
func TestTimelineChangesMore_AReadWithThemIsNotSharedWithOneWithout(t *testing.T) {
	api := moreFixture()
	api.hold, api.started = make(chan struct{}), make(chan struct{})
	s := api.service(t)
	answers := make(chan *TimelineChangesResult, 1)
	go func() {
		res, err := s.GetTimelineChanges(context.Background(), "shop", moreBack(4*time.Hour), moreNow, TimelineChangesMax)
		if err != nil {
			t.Error(err)
		}
		answers <- res
	}()
	<-api.started // its first list waits
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	with, err := s.GetTimelineChangesMore(ctx, "shop", moreBack(4*time.Hour), moreNow, TimelineChangesMax)
	close(api.hold)
	without := <-answers
	if err != nil {
		t.Fatal(err)
	}
	if _, has := moreBySource(with)["jobs"]; !has {
		t.Errorf("with them: %v", moreBySource(with))
	}
	if _, has := moreBySource(without)["jobs"]; has {
		t.Errorf("without them: %v", moreBySource(without))
	}
}
