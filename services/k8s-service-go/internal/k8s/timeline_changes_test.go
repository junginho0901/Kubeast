package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
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

	mu    sync.Mutex
	asked []changesAsk
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

func (a *changesAPI) serve(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	a.asked = append(a.asked, changesAsk{r.URL.Path, r.Header.Get("Accept")})
	a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	resource := parts[len(parts)-1]
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
		body = appsv1.ReplicaSetList{TypeMeta: metav1.TypeMeta{Kind: "ReplicaSetList", APIVersion: "apps/v1"}, Items: chgIn(a.rs, ns, func(x appsv1.ReplicaSet) string { return x.Namespace })}
	case "controllerrevisions":
		body = appsv1.ControllerRevisionList{TypeMeta: metav1.TypeMeta{Kind: "ControllerRevisionList", APIVersion: "apps/v1"}, Items: chgIn(a.crs, ns, func(x appsv1.ControllerRevision) string { return x.Namespace })}
	case "configmaps":
		items := chgIn(a.cms, ns, func(x corev1.ConfigMap) string { return x.Namespace })
		if !metadataOnly {
			body = corev1.ConfigMapList{TypeMeta: metav1.TypeMeta{Kind: "ConfigMapList", APIVersion: "v1"}, Items: items}
			break
		}
		metas := []metav1.ObjectMeta{}
		for _, it := range items {
			metas = append(metas, it.ObjectMeta)
		}
		body = chgMetadata(metas)
	case "secrets":
		items := chgIn(a.secrets, ns, func(x corev1.Secret) string { return x.Namespace })
		if !metadataOnly {
			body = corev1.SecretList{TypeMeta: metav1.TypeMeta{Kind: "SecretList", APIVersion: "v1"}, Items: items}
			break
		}
		metas := []metav1.ObjectMeta{}
		for _, it := range items {
			metas = append(metas, it.ObjectMeta)
		}
		body = chgMetadata(metas)
	case "horizontalpodautoscalers":
		body = autoscalingv2.HorizontalPodAutoscalerList{TypeMeta: metav1.TypeMeta{Kind: "HorizontalPodAutoscalerList", APIVersion: "autoscaling/v2"}, Items: chgIn(a.hpas, ns, func(x autoscalingv2.HorizontalPodAutoscaler) string { return x.Namespace })}
	case "nodes":
		body = corev1.NodeList{TypeMeta: metav1.TypeMeta{Kind: "NodeList", APIVersion: "v1"}, Items: a.nodes}
	case "pods":
		body = corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, Items: chgIn(a.pods, ns, func(x corev1.Pod) string { return x.Namespace })}
	case "applications":
		if a.apps == nil {
			chgStatus(w, http.StatusNotFound, "NotFound", "the server could not find the requested resource")
			return
		}
		items := chgIn(a.apps, ns, func(x map[string]interface{}) string {
			return x["metadata"].(map[string]interface{})["namespace"].(string)
		})
		body = map[string]interface{}{"apiVersion": "argoproj.io/v1alpha1", "kind": "ApplicationList", "metadata": map[string]interface{}{}, "items": items}
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
	s.defaultBundle.Store(&clientBundle{clientset: cs, dynamic: dyn})
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
