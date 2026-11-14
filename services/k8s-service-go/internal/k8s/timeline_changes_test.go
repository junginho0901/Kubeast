package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// changesAPI answers the lists of the changes view as the API server does: ConfigMaps and Secrets whole, values too,
// unless the request asks for metadata only, and Argo CD's Applications only when apps is set.
type changesAPI struct {
	rs      []appsv1.ReplicaSet
	crs     []appsv1.ControllerRevision
	cms     []corev1.ConfigMap
	secrets []corev1.Secret
	hpas    []autoscalingv2.HorizontalPodAutoscaler
	nodes   []corev1.Node
	pods    []corev1.Pod
	apps    []map[string]interface{}
	refuse  map[string]bool
	// pageSize > 0 answers that many objects a page whatever the limit asked, as an API server may
	pageSize int
	// podsEverywhere answers the access review of listing pods across the cluster (set reviews to ask one)
	reviews, podsEverywhere bool
	// hold, when set, keeps the first list waiting until it is closed; started is closed when that list came
	hold, started chan struct{}

	mu      sync.Mutex
	asked   []changesAsk
	inUse   int // the most bigReadSlots places held while a list was asked
	holding bool
}

type changesAsk struct{ path, accept string }

func chgStatus(w http.ResponseWriter, code int, reason, message string) {
	w.WriteHeader(code)
	_, _ = fmt.Fprintf(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":%q,"code":%d,"message":%q}`, reason, code, message)
}

func chgIn[T any](items []T, ns string, of func(T) string) []T {
	out := []T{}
	for _, it := range items {
		if ns == "" || of(it) == ns {
			out = append(out, it)
		}
	}
	return out
}

// chgMetadata is what the API server gives for as=PartialObjectMetadataList: each object's metadata, nothing else.
func chgMetadata(metas []metav1.ObjectMeta) metav1.PartialObjectMetadataList {
	list := metav1.PartialObjectMetadataList{TypeMeta: metav1.TypeMeta{Kind: "PartialObjectMetadataList", APIVersion: "meta.k8s.io/v1"}}
	for _, m := range metas {
		list.Items = append(list.Items, metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{Kind: "PartialObjectMetadata", APIVersion: "meta.k8s.io/v1"}, ObjectMeta: m})
	}
	return list
}

// chgPage is the page of items a list asks for when the stand-in pages by pageSize: continue is the offset.
func chgPage[T any](a *changesAPI, items []T, r *http.Request) ([]T, metav1.ListMeta) {
	if a.pageSize <= 0 {
		return items, metav1.ListMeta{}
	}
	from, _ := strconv.Atoi(r.URL.Query().Get("continue"))
	to := min(from+a.pageSize, len(items))
	if from > to {
		from = to
	}
	meta := metav1.ListMeta{}
	if to < len(items) {
		meta.Continue = strconv.Itoa(to)
	}
	return items[from:to], meta
}

func (a *changesAPI) serve(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	a.asked = append(a.asked, changesAsk{r.URL.Path, r.Header.Get("Accept")})
	a.inUse = max(a.inUse, bigReadSlots.InUse())
	first := a.hold != nil && !a.holding
	a.holding = a.holding || first
	a.mu.Unlock()
	if first {
		close(a.started)
		<-a.hold
	}
	w.Header().Set("Content-Type", "application/json")
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	resource := parts[len(parts)-1]
	if resource == "selfsubjectaccessreviews" {
		body, _ := io.ReadAll(r.Body)
		review := &authorizationv1.SelfSubjectAccessReview{}
		if _, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, review); err != nil || review.Spec.ResourceAttributes == nil {
			http.Error(w, "unreadable review", http.StatusBadRequest)
			return
		}
		attrs := review.Spec.ResourceAttributes
		review.APIVersion, review.Kind = "authorization.k8s.io/v1", "SelfSubjectAccessReview"
		review.Status.Allowed = attrs.Resource != "pods" || attrs.Namespace != "" || a.podsEverywhere
		_ = json.NewEncoder(w).Encode(review)
		return
	}
	ns := ""
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "namespaces" {
			ns = parts[i+1]
		}
	}
	if a.refuse[resource] {
		chgStatus(w, http.StatusForbidden, "Forbidden", resource+" is forbidden")
		return
	}
	metadataOnly := strings.Contains(r.Header.Get("Accept"), "as=PartialObjectMetadataList")
	var body interface{}
	switch resource {
	case "replicasets":
		items, meta := chgPage(a, chgIn(a.rs, ns, func(x appsv1.ReplicaSet) string { return x.Namespace }), r)
		body = appsv1.ReplicaSetList{TypeMeta: metav1.TypeMeta{Kind: "ReplicaSetList", APIVersion: "apps/v1"}, ListMeta: meta, Items: items}
	case "controllerrevisions":
		items, meta := chgPage(a, chgIn(a.crs, ns, func(x appsv1.ControllerRevision) string { return x.Namespace }), r)
		body = appsv1.ControllerRevisionList{TypeMeta: metav1.TypeMeta{Kind: "ControllerRevisionList", APIVersion: "apps/v1"}, ListMeta: meta, Items: items}
	case "configmaps":
		items, meta := chgPage(a, chgIn(a.cms, ns, func(x corev1.ConfigMap) string { return x.Namespace }), r)
		if !metadataOnly {
			body = corev1.ConfigMapList{TypeMeta: metav1.TypeMeta{Kind: "ConfigMapList", APIVersion: "v1"}, ListMeta: meta, Items: items}
			break
		}
		metas := []metav1.ObjectMeta{}
		for _, it := range items {
			metas = append(metas, it.ObjectMeta)
		}
		list := chgMetadata(metas)
		list.ListMeta = meta
		body = list
	case "secrets":
		items, meta := chgPage(a, chgIn(a.secrets, ns, func(x corev1.Secret) string { return x.Namespace }), r)
		if !metadataOnly {
			body = corev1.SecretList{TypeMeta: metav1.TypeMeta{Kind: "SecretList", APIVersion: "v1"}, ListMeta: meta, Items: items}
			break
		}
		metas := []metav1.ObjectMeta{}
		for _, it := range items {
			metas = append(metas, it.ObjectMeta)
		}
		list := chgMetadata(metas)
		list.ListMeta = meta
		body = list
	case "horizontalpodautoscalers":
		items, meta := chgPage(a, chgIn(a.hpas, ns, func(x autoscalingv2.HorizontalPodAutoscaler) string { return x.Namespace }), r)
		body = autoscalingv2.HorizontalPodAutoscalerList{TypeMeta: metav1.TypeMeta{Kind: "HorizontalPodAutoscalerList", APIVersion: "autoscaling/v2"}, ListMeta: meta, Items: items}
	case "nodes":
		items, meta := chgPage(a, a.nodes, r)
		body = corev1.NodeList{TypeMeta: metav1.TypeMeta{Kind: "NodeList", APIVersion: "v1"}, ListMeta: meta, Items: items}
	case "pods":
		items, meta := chgPage(a, chgIn(a.pods, ns, func(x corev1.Pod) string { return x.Namespace }), r)
		body = corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, ListMeta: meta, Items: items}
	case "applications":
		if a.apps == nil {
			chgStatus(w, http.StatusNotFound, "NotFound", "the server could not find the requested resource")
			return
		}
		items, meta := chgPage(a, chgIn(a.apps, ns, func(x map[string]interface{}) string {
			return x["metadata"].(map[string]interface{})["namespace"].(string)
		}), r)
		body = map[string]interface{}{"apiVersion": "argoproj.io/v1alpha1", "kind": "ApplicationList", "metadata": map[string]interface{}{"continue": meta.Continue}, "items": items}
	default:
		chgStatus(w, http.StatusNotFound, "NotFound", "the server could not find the requested resource")
		return
	}
	_ = json.NewEncoder(w).Encode(body)
}

func (a *changesAPI) service(t *testing.T) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(a.serve))
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

func (a *changesAPI) paths() []changesAsk {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]changesAsk(nil), a.asked...)
}

var chgTrue = true

func chgOwner(kind, name string) []metav1.OwnerReference {
	return []metav1.OwnerReference{{Kind: kind, Name: name, Controller: &chgTrue}}
}

func chgReplicaSet(ns, name, deployment, revision string, created time.Time, image string, env ...corev1.EnvVar) appsv1.ReplicaSet {
	return appsv1.ReplicaSet{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: ns, CreationTimestamp: metav1.NewTime(created),
			Annotations:     map[string]string{"deployment.kubernetes.io/revision": revision},
			OwnerReferences: chgOwner("Deployment", deployment),
		},
		Spec: appsv1.ReplicaSetSpec{Template: corev1.PodTemplateSpec{
			ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": deployment, "pod-template-hash": name}},
			Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: deployment, Image: image, Env: env}}},
		}},
	}
}

func chgWritten(manager string, at time.Time) metav1.ManagedFieldsEntry {
	t := metav1.NewTime(at)
	return metav1.ManagedFieldsEntry{Manager: manager, Operation: metav1.ManagedFieldsOperationUpdate, APIVersion: "v1", Time: &t}
}

func chgWindow() (now, since, until time.Time) {
	now = time.Now().UTC().Truncate(time.Second)
	return now, now.Add(-4 * time.Hour), now
}

func chgRead(t *testing.T, s *Service, ctx context.Context, namespace string, since, until time.Time) *TimelineChangesResult {
	t.Helper()
	res, err := s.GetTimelineChanges(ctx, namespace, since, until, TimelineChangesMax)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func chgOfKind(res *TimelineChangesResult, kind string) []TimelineChange {
	var out []TimelineChange
	for _, ch := range res.Changes {
		if ch.Kind == kind {
			out = append(out, ch)
		}
	}
	return out
}

func chgJSON(t *testing.T, v interface{}) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// A rollout says what its pod template changed from the revision before: the image with both, a field by its name and
// the env keys added and changed, with no value of any. The label a Deployment adds to each ReplicaSet is no change.
func TestTimelineChanges_ARolloutNamesTheImageFieldsAndEnvKeysThatChanged(t *testing.T) {
	now, since, until := chgWindow()
	before := chgReplicaSet("shop", "web-1", "web", "1", now.Add(-48*time.Hour), "web:1",
		corev1.EnvVar{Name: "DB_HOST", Value: "db-old.internal"}, corev1.EnvVar{Name: "API_TOKEN", Value: "token-value-one"})
	after := chgReplicaSet("shop", "web-2", "web", "2", now.Add(-time.Hour), "web:2",
		corev1.EnvVar{Name: "DB_HOST", Value: "db-new.internal"}, corev1.EnvVar{Name: "API_TOKEN", Value: "token-value-one"}, corev1.EnvVar{Name: "FEATURE_X", Value: "flag-value-on"})
	after.Spec.Template.Spec.Containers[0].Args = []string{"--workers=4"}
	api := &changesAPI{rs: []appsv1.ReplicaSet{before, after}}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)

	rollouts := chgOfKind(res, "Deployment")
	if len(rollouts) != 1 {
		t.Fatalf("rollouts %+v, want the one of the window", rollouts)
	}
	ch := rollouts[0]
	if ch.Name != "web" || ch.Namespace != "shop" || ch.What != "rollout" || ch.From != int64(1) || ch.To != int64(2) || ch.When != now.Add(-time.Hour).Format(time.RFC3339) {
		t.Fatalf("rollout %+v", ch)
	}
	want := []FieldChange{
		{Field: "image", Container: "web", From: "web:1", To: "web:2"},
		{Field: "env", Container: "web", KeysAdded: []string{"FEATURE_X"}, KeysChanged: []string{"DB_HOST"}},
		{Field: "args", Container: "web"},
	}
	if !reflect.DeepEqual(ch.Changed, want) {
		t.Fatalf("changed %+v, want %+v", ch.Changed, want)
	}
	answer := chgJSON(t, res)
	for _, value := range []string{"db-old.internal", "db-new.internal", "token-value-one", "flag-value-on", "--workers=4"} {
		if strings.Contains(answer, value) {
			t.Fatalf("the answer holds the value %q: %s", value, answer)
		}
	}
}

// A StatefulSet's revision is its ControllerRevision, compared with the newest one before the window.
func TestTimelineChanges_AControllerRevisionIsComparedWithTheOneBefore(t *testing.T) {
	now, since, until := chgWindow()
	revision := func(name string, rev int64, created time.Time, image string) appsv1.ControllerRevision {
		return appsv1.ControllerRevision{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "shop", CreationTimestamp: metav1.NewTime(created), OwnerReferences: chgOwner("StatefulSet", "db")},
			Revision:   rev,
			Data: runtime.RawExtension{Raw: []byte(fmt.Sprintf(
				`{"spec":{"template":{"$patch":"replace","metadata":{"labels":{"app":"db"}},"spec":{"containers":[{"name":"db","image":%q}]}}}}`, image))},
		}
	}
	api := &changesAPI{crs: []appsv1.ControllerRevision{
		revision("db-a", 2, now.Add(-30*24*time.Hour), "db:1"),
		revision("db-b", 3, now.Add(-10*24*time.Hour), "db:2"),
		revision("db-c", 4, now.Add(-2*time.Hour), "db:3"),
	}}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)
	got := chgOfKind(res, "StatefulSet")
	if len(got) != 1 || got[0].From != int64(3) || got[0].To != int64(4) {
		t.Fatalf("revisions %+v, want 3 → 4", got)
	}
	if want := []FieldChange{{Field: "image", Container: "db", From: "db:2", To: "db:3"}}; !reflect.DeepEqual(got[0].Changed, want) {
		t.Fatalf("changed %+v, want %+v", got[0].Changed, want)
	}
}

// A ConfigMap was last written when its newest managedFields entry says, by that entry's manager; one made in the window
// and not written since is created, and one last written before it is no change.
func TestTimelineChanges_AConfigMapsLastWriteIsItsNewestManagedFieldsTime(t *testing.T) {
	now, since, until := chgWindow()
	old := now.Add(-10 * 24 * time.Hour)
	api := &changesAPI{cms: []corev1.ConfigMap{
		{ObjectMeta: metav1.ObjectMeta{Name: "app-config", Namespace: "shop", CreationTimestamp: metav1.NewTime(old),
			ManagedFields: []metav1.ManagedFieldsEntry{chgWritten("kubectl-client-side-apply", old), chgWritten("kubectl-edit", now.Add(-30*time.Minute))}},
			Data: map[string]string{"LOG_LEVEL": "debug-value"}},
		{ObjectMeta: metav1.ObjectMeta{Name: "fresh", Namespace: "shop", CreationTimestamp: metav1.NewTime(now.Add(-time.Hour)),
			ManagedFields: []metav1.ManagedFieldsEntry{chgWritten("helm", now.Add(-time.Hour))}}},
		{ObjectMeta: metav1.ObjectMeta{Name: "quiet", Namespace: "shop", CreationTimestamp: metav1.NewTime(old),
			ManagedFields: []metav1.ManagedFieldsEntry{chgWritten("kubectl-edit", now.Add(-5*time.Hour))}}},
	}}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)
	got := chgOfKind(res, "ConfigMap")
	want := []TimelineChange{
		{When: now.Add(-30 * time.Minute).Format(time.RFC3339), Kind: "ConfigMap", Name: "app-config", Namespace: "shop", What: "written", By: "kubectl-edit", at: now.Add(-30 * time.Minute)},
		{When: now.Add(-time.Hour).Format(time.RFC3339), Kind: "ConfigMap", Name: "fresh", Namespace: "shop", What: "created", By: "helm", at: now.Add(-time.Hour)},
	}
	if len(got) != len(want) {
		t.Fatalf("configmaps %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i].When != want[i].When || got[i].Name != want[i].Name || got[i].What != want[i].What || got[i].By != want[i].By {
			t.Fatalf("configmap %d: %+v, want %+v", i, got[i], want[i])
		}
	}
	if strings.Contains(chgJSON(t, res), "debug-value") {
		t.Fatal("a ConfigMap's value is in the answer")
	}
}

// Secrets and ConfigMaps are asked for as metadata only, so no value leaves the API server; a Helm release's Secret is
// that release's revision.
func TestTimelineChanges_SecretsAreAskedForTheirMetadataOnly(t *testing.T) {
	now, since, until := chgWindow()
	old := now.Add(-10 * 24 * time.Hour)
	api := &changesAPI{secrets: []corev1.Secret{
		{ObjectMeta: metav1.ObjectMeta{Name: "db-credentials", Namespace: "shop", CreationTimestamp: metav1.NewTime(old),
			ManagedFields: []metav1.ManagedFieldsEntry{chgWritten("external-secrets", now.Add(-20*time.Minute))}},
			Data: map[string][]byte{"password": []byte("hunter2-value")}},
		{ObjectMeta: metav1.ObjectMeta{Name: "sh.helm.release.v1.shop-app.v3", Namespace: "shop", CreationTimestamp: metav1.NewTime(now.Add(-2 * time.Hour)),
			Labels: map[string]string{"owner": "helm", "name": "shop-app", "version": "3", "status": "deployed"}},
			Data: map[string][]byte{"release": []byte("release-body-value")}},
	}}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)

	asked := 0
	for _, ask := range api.paths() {
		if strings.HasSuffix(ask.path, "/secrets") || strings.HasSuffix(ask.path, "/configmaps") {
			asked++
			if ask.accept != metadataListAccept {
				t.Errorf("%s asked with Accept %q, want metadata only", ask.path, ask.accept)
			}
		}
	}
	if asked != 2 {
		t.Fatalf("%d lists of Secrets and ConfigMaps, want one of each: %+v", asked, api.paths())
	}
	answer := chgJSON(t, res)
	for _, value := range []string{"hunter2-value", "release-body-value"} {
		if strings.Contains(answer, value) {
			t.Fatalf("the answer holds %q: %s", value, answer)
		}
	}
	secrets := chgOfKind(res, "Secret")
	if len(secrets) != 1 || secrets[0].Name != "db-credentials" || secrets[0].What != "written" || secrets[0].By != "external-secrets" {
		t.Fatalf("secrets %+v, want db-credentials written by external-secrets", secrets)
	}
	helm := chgOfKind(res, "HelmRelease")
	if len(helm) != 1 || helm[0].Name != "shop-app" || helm[0].From != 2 || helm[0].To != 3 || helm[0].Note != "status now deployed" {
		t.Fatalf("helm %+v, want shop-app 2 → 3, deployed", helm)
	}
	if by := res.Summary["by_source"].(map[string]interface{}); by["secrets"] != 1 || by["helm"] != 1 {
		t.Fatalf("by_source %v", by)
	}
}

// An HPA's last scale is when it set its desired count, with how many run now.
func TestTimelineChanges_AnHPAScaledInTheWindow(t *testing.T) {
	now, since, until := chgWindow()
	scaled := metav1.NewTime(now.Add(-20 * time.Minute))
	long := metav1.NewTime(now.Add(-6 * time.Hour))
	api := &changesAPI{hpas: []autoscalingv2.HorizontalPodAutoscaler{
		{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"},
			Spec:   autoscalingv2.HorizontalPodAutoscalerSpec{ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{Kind: "Deployment", Name: "web", APIVersion: "apps/v1"}},
			Status: autoscalingv2.HorizontalPodAutoscalerStatus{LastScaleTime: &scaled, CurrentReplicas: 3, DesiredReplicas: 5}},
		{ObjectMeta: metav1.ObjectMeta{Name: "worker", Namespace: "shop"},
			Status: autoscalingv2.HorizontalPodAutoscalerStatus{LastScaleTime: &long, CurrentReplicas: 2, DesiredReplicas: 2}},
	}}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)
	got := chgOfKind(res, "HorizontalPodAutoscaler")
	if len(got) != 1 || got[0].Name != "web" || got[0].What != "scaled" || got[0].To != int32(5) || got[0].When != scaled.UTC().Format(time.RFC3339) {
		t.Fatalf("hpas %+v, want web scaled to 5", got)
	}
	if got[0].Note != "3 running now, of Deployment web" {
		t.Fatalf("note %q", got[0].Note)
	}
}

// A node that went NotReady in the window is a change with its reason; a new node's first fine conditions are its start.
func TestTimelineChanges_ANodeNotReadyAndANewNode(t *testing.T) {
	now, since, until := chgWindow()
	cond := func(typ corev1.NodeConditionType, status corev1.ConditionStatus, reason string, at time.Time) corev1.NodeCondition {
		return corev1.NodeCondition{Type: typ, Status: status, Reason: reason, LastTransitionTime: metav1.NewTime(at)}
	}
	month := now.Add(-30 * 24 * time.Hour)
	created := now.Add(-time.Hour)
	api := &changesAPI{nodes: []corev1.Node{
		{ObjectMeta: metav1.ObjectMeta{Name: "node-a", CreationTimestamp: metav1.NewTime(month)},
			Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
				cond(corev1.NodeMemoryPressure, corev1.ConditionFalse, "KubeletHasSufficientMemory", month),
				cond(corev1.NodeReady, corev1.ConditionFalse, "KubeletNotReady", now.Add(-10*time.Minute)),
			}}},
		{ObjectMeta: metav1.ObjectMeta{Name: "node-b", CreationTimestamp: metav1.NewTime(created)},
			Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
				cond(corev1.NodeMemoryPressure, corev1.ConditionFalse, "KubeletHasSufficientMemory", created.Add(10*time.Second)),
				cond(corev1.NodeReady, corev1.ConditionTrue, "KubeletReady", created.Add(40*time.Second)),
			}}},
	}}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)
	got := chgOfKind(res, "Node")
	if len(got) != 2 {
		t.Fatalf("nodes %+v, want node-a NotReady and node-b created", got)
	}
	if got[0].Name != "node-a" || got[0].What != "condition Ready" || got[0].To != "False" || got[0].Reason != "KubeletNotReady" {
		t.Fatalf("first %+v, want node-a Ready → False", got[0])
	}
	if got[1].Name != "node-b" || got[1].What != "created" {
		t.Fatalf("second %+v, want node-b created", got[1])
	}
}

// A container's last termination in the window is a restart with its reason and exit code, as the issues read it.
func TestTimelineChanges_AContainerRestartedWithItsReason(t *testing.T) {
	now, since, until := chgWindow()
	api := &changesAPI{pods: []corev1.Pod{{
		ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "shop"},
		Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{
			{Name: "app", RestartCount: 4, LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
				Reason: "OOMKilled", ExitCode: 137, FinishedAt: metav1.NewTime(now.Add(-5 * time.Minute))}}},
			{Name: "sidecar", RestartCount: 1, LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
				Reason: "Error", ExitCode: 1, FinishedAt: metav1.NewTime(now.Add(-9 * time.Hour))}}},
		}},
	}}}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)
	got := chgOfKind(res, "Pod")
	if len(got) != 1 || got[0].Name != "web-1" || got[0].Container != "app" || got[0].Reason != "OOMKilled (exit 137)" || got[0].Note != "4 restarts" {
		t.Fatalf("restarts %+v, want app OOMKilled", got)
	}
}

// At most TimelineChangesMax are listed, the newest, and every change of the window is counted.
func TestTimelineChanges_TheNewestFiftyAreKeptAndAllCounted(t *testing.T) {
	now, since, until := chgWindow()
	api := &changesAPI{}
	for i := 0; i < 70; i++ {
		at := now.Add(-time.Duration(i) * time.Minute)
		api.cms = append(api.cms, corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{
			Name: fmt.Sprintf("cm-%02d", i), Namespace: "shop", CreationTimestamp: metav1.NewTime(now.Add(-24 * time.Hour)),
			ManagedFields: []metav1.ManagedFieldsEntry{chgWritten("kubectl-edit", at)},
		}})
	}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)
	if len(res.Changes) != TimelineChangesMax {
		t.Fatalf("%d changes listed, want %d", len(res.Changes), TimelineChangesMax)
	}
	for i, ch := range res.Changes {
		if want := fmt.Sprintf("cm-%02d", i); ch.Name != want {
			t.Fatalf("change %d is %s, want %s: the newest first", i, ch.Name, want)
		}
	}
	if res.Summary["changes_total"] != 70 || res.Summary["changes_shown"] != TimelineChangesMax {
		t.Fatalf("summary %v, want 70 counted and 50 shown", res.Summary)
	}
	if by := res.Summary["by_source"].(map[string]interface{}); by["configmaps"] != 70 {
		t.Fatalf("by_source %v", by)
	}
}

// A caller limited to namespaces reads each of them and nothing of another: no list of a namespaced kind across
// namespaces, no object of another namespace in the answer.
func TestTimelineChanges_ACallerLimitedToANamespaceReadsOnlyIt(t *testing.T) {
	now, since, until := chgWindow()
	api := &changesAPI{apps: []map[string]interface{}{}}
	for _, ns := range []string{"alpha", "beta"} {
		api.rs = append(api.rs, chgReplicaSet(ns, "web-1", "web", "1", now.Add(-time.Hour), "web:1"))
		api.cms = append(api.cms, corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "cfg-" + ns, Namespace: ns, CreationTimestamp: metav1.NewTime(now.Add(-time.Hour))}})
	}
	ctx := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"alpha"}}})
	res := chgRead(t, api.service(t), ctx, "", since, until)

	for _, ask := range api.paths() {
		if ask.path == "/api/v1/nodes" {
			continue
		}
		if !strings.Contains(ask.path, "/namespaces/alpha/") {
			t.Errorf("asked %s, outside the grant's namespace", ask.path)
		}
	}
	if len(res.Changes) == 0 {
		t.Fatal("nothing read of the grant's own namespace")
	}
	for _, ch := range res.Changes {
		if ch.Namespace != "alpha" {
			t.Errorf("a change of %q: %+v", ch.Namespace, ch)
		}
	}
}

// A source the cluster refuses is named with why and counts null, not zero; the others still answer. When every one
// of a namespace's sources is refused, that refusal is the answer.
func TestTimelineChanges_ARefusedSourceIsNotCountedAsNone(t *testing.T) {
	now, since, until := chgWindow()
	api := &changesAPI{
		refuse: map[string]bool{"secrets": true},
		cms:    []corev1.ConfigMap{{ObjectMeta: metav1.ObjectMeta{Name: "cfg", Namespace: "shop", CreationTimestamp: metav1.NewTime(now.Add(-time.Hour))}}},
	}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)
	notRead, _ := res.Summary["not_read"].(map[string]string)
	if !strings.Contains(notRead["secrets"], "forbidden") {
		t.Fatalf("not_read %v, want the Secrets refusal", res.Summary["not_read"])
	}
	by := res.Summary["by_source"].(map[string]interface{})
	if v, ok := by["secrets"]; !ok || v != nil {
		t.Fatalf("by_source.secrets %v, want null", by["secrets"])
	}
	if v, ok := by["helm"]; !ok || v != nil {
		t.Fatalf("by_source.helm %v, want null: Helm keeps its releases in Secrets", by["helm"])
	}
	if len(chgOfKind(res, "ConfigMap")) != 1 || by["configmaps"] != 1 {
		t.Fatalf("the ConfigMaps were not read: %+v", res)
	}

	all := &changesAPI{refuse: map[string]bool{"replicasets": true, "configmaps": true, "secrets": true, "horizontalpodautoscalers": true, "pods": true}}
	if _, err := all.service(t).GetTimelineChanges(context.Background(), "shop", since, until, TimelineChangesMax); !apierrors.IsForbidden(err) {
		t.Fatalf("every source refused: %v, want the refusal", err)
	}
}

// An Argo CD Application's syncs of the window come from its history, the one before each as where it came from; a
// cluster without Argo CD says so and counts null.
func TestTimelineChanges_ArgoCDSyncsFromTheApplicationsHistory(t *testing.T) {
	now, since, until := chgWindow()
	app := func(name, dest string) map[string]interface{} {
		return map[string]interface{}{
			"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
			"metadata": map[string]interface{}{"name": name, "namespace": "argocd"},
			"spec":     map[string]interface{}{"destination": map[string]interface{}{"namespace": dest}},
			"status": map[string]interface{}{"history": []interface{}{
				map[string]interface{}{"id": int64(1), "revision": "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deployedAt": now.Add(-48 * time.Hour).Format(time.RFC3339)},
				map[string]interface{}{"id": int64(2), "revision": "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "deployedAt": now.Add(-15 * time.Minute).Format(time.RFC3339)},
			}},
		}
	}
	api := &changesAPI{apps: []map[string]interface{}{app("shop", "shop"), app("other", "billing")}}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)
	got := chgOfKind(res, "Application")
	if len(got) != 1 || got[0].Name != "shop" || got[0].What != "synced" || got[0].From != "1111111" || got[0].To != "2222222" || got[0].Note != "deploys to shop" {
		t.Fatalf("syncs %+v, want shop 1111111 → 2222222", got)
	}

	none := &changesAPI{}
	res = chgRead(t, none.service(t), context.Background(), "shop", since, until)
	notes, _ := res.Summary["notes"].(map[string]string)
	if !strings.Contains(notes["argocd"], "not served") {
		t.Fatalf("notes %v, want Argo CD not served", res.Summary["notes"])
	}
	if by := res.Summary["by_source"].(map[string]interface{}); by["argocd"] != nil {
		t.Fatalf("by_source.argocd %v, want null", by["argocd"])
	}
}

// A changes read asks its sources one after another: past a page each takes a place among bigReadSlots as every paged
// read does, so the read holds at most one place at a time, never more than the sources it reads, and none after.
func TestTimelineChanges_AReadHoldsOneBigReadPlaceAtATime(t *testing.T) {
	now, since, until := chgWindow()
	api := &changesAPI{pageSize: 2, apps: []map[string]interface{}{}}
	for i := 0; i < 5; i++ {
		// revisions 5 to 2 in the window, 1 just before it
		api.rs = append(api.rs, chgReplicaSet("shop", fmt.Sprintf("web-%d", i), "web", strconv.Itoa(5-i), now.Add(-time.Duration(i)*time.Hour-time.Minute), "web:"+strconv.Itoa(5-i)))
		api.crs = append(api.crs, appsv1.ControllerRevision{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("db-%d", i), Namespace: "shop", OwnerReferences: chgOwner("StatefulSet", "db")}, Revision: int64(i + 1)})
		api.cms = append(api.cms, corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("cm-%d", i), Namespace: "shop"}})
		api.secrets = append(api.secrets, corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("s-%d", i), Namespace: "shop"}})
		api.hpas = append(api.hpas, autoscalingv2.HorizontalPodAutoscaler{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("h-%d", i), Namespace: "shop"}})
		api.nodes = append(api.nodes, corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("n-%d", i)}})
		api.pods = append(api.pods, corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("p-%d", i), Namespace: "shop"}})
		api.apps = append(api.apps, map[string]interface{}{"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
			"metadata": map[string]interface{}{"name": fmt.Sprintf("a-%d", i), "namespace": "shop"}})
	}
	res := chgRead(t, api.service(t), context.Background(), "shop", since, until)
	if got := len(chgOfKind(res, "Deployment")); got != 4 {
		t.Fatalf("%d rollouts, want the 4 of the window: the pages were not all read", got)
	}
	pages := map[string]int{}
	for _, ask := range api.paths() {
		pages[ask.path]++
	}
	if len(pages) != 8 {
		t.Fatalf("lists %v, want the 8 sources", pages)
	}
	for path, n := range pages {
		if n != 3 {
			t.Errorf("%s read in %d pages, want 3", path, n)
		}
	}
	if api.inUse != 1 {
		t.Fatalf("at most %d places held at once, want one at a time", api.inUse)
	}
	if n := bigReadSlots.InUse(); n != 0 {
		t.Fatalf("%d places still held after the read", n)
	}
}

// Two calls for the same window by the same identity at one moment share one read: each list is asked once and both
// get its answer.
func TestTimelineChanges_TwoIdenticalCallsAtOnceReadOnce(t *testing.T) {
	now, since, until := chgWindow()
	api := &changesAPI{hold: make(chan struct{}), started: make(chan struct{}), apps: []map[string]interface{}{}}
	api.cms = []corev1.ConfigMap{{ObjectMeta: metav1.ObjectMeta{Name: "cfg", Namespace: "shop", CreationTimestamp: metav1.NewTime(now.Add(-time.Hour))}}}
	s := api.service(t)
	results := make([]*TimelineChangesResult, 2)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	call := func(i int) {
		defer wg.Done()
		results[i], errs[i] = s.GetTimelineChanges(context.Background(), "shop", since, until, TimelineChangesMax)
	}
	wg.Add(1)
	go call(0)
	<-api.started
	wg.Add(1)
	go call(1)
	// the second call reaches the read under way while its first list waits
	time.Sleep(300 * time.Millisecond)
	close(api.hold)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if results[0] != results[1] || len(chgOfKind(results[0], "ConfigMap")) != 1 {
		t.Fatalf("answers %+v and %+v, want one shared answer", results[0], results[1])
	}
	asked := map[string]int{}
	for _, ask := range api.paths() {
		asked[ask.path]++
	}
	for path, n := range asked {
		if n != 1 {
			t.Errorf("%s asked %d times, want once for both calls", path, n)
		}
	}
}

// Without a namespace, every namespace's restarts are read only for a caller who may list pods across the cluster;
// another is told they were skipped and asked to name a namespace, which reads that namespace's pods.
func TestTimelineChanges_EveryNamespacesRestartsNeedListingPodsAcrossTheCluster(t *testing.T) {
	now, since, until := chgWindow()
	pods := []corev1.Pod{{
		ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "shop"},
		Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "app", RestartCount: 1,
			LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1, FinishedAt: metav1.NewTime(now.Add(-time.Minute))}}}}},
	}}

	refused := &changesAPI{reviews: true, pods: pods}
	res := chgRead(t, refused.service(t), context.Background(), "", since, until)
	skipped, _ := res.Summary["skipped"].(map[string]string)
	if !strings.Contains(skipped["pods"], "name a namespace") {
		t.Fatalf("skipped %v, want the restarts named", res.Summary["skipped"])
	}
	if by := res.Summary["by_source"].(map[string]interface{}); by["pods"] != nil {
		t.Fatalf("by_source.pods %v, want null", by["pods"])
	}
	for _, ask := range refused.paths() {
		if strings.HasSuffix(ask.path, "/pods") {
			t.Fatalf("pods listed: %s", ask.path)
		}
	}

	allowed := &changesAPI{reviews: true, podsEverywhere: true, pods: pods}
	if got := chgOfKind(chgRead(t, allowed.service(t), context.Background(), "", since, until), "Pod"); len(got) != 1 {
		t.Fatalf("restarts %+v, want web-1's for a caller who may list pods everywhere", got)
	}
	named := &changesAPI{reviews: true, pods: pods}
	if got := chgOfKind(chgRead(t, named.service(t), context.Background(), "shop", since, until), "Pod"); len(got) != 1 {
		t.Fatalf("restarts %+v, want web-1's in the namespace named", got)
	}
}

// A ReplicaSet made before the window holding a higher revision than the window's first rollout was brought back by
// a rollback after it: that rollout's note says so, with nothing compared.
func TestTimelineChanges_ARollbackAfterARolloutIsSaid(t *testing.T) {
	now, since, until := chgWindow()
	api := &changesAPI{rs: []appsv1.ReplicaSet{
		chgReplicaSet("shop", "web-a", "web", "5", now.Add(-10*24*time.Hour), "web:1"),
		chgReplicaSet("shop", "web-b", "web", "4", now.Add(-time.Hour), "web:2"),
	}}
	got := chgOfKind(chgRead(t, api.service(t), context.Background(), "shop", since, until), "Deployment")
	if len(got) != 1 || got[0].To != int64(4) || got[0].From != nil || got[0].Changed != nil {
		t.Fatalf("rollouts %+v, want revision 4 with nothing compared", got)
	}
	if !strings.Contains(got[0].Note, "rolled back after this rollout: revision 5") {
		t.Fatalf("note %q", got[0].Note)
	}
}
