package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"reflect"
	"runtime"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/tools/cache"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

var (
	refConfigMaps = []string{"app-config", "feature-flags", "kube-root-ca.crt", "nginx-conf", "shared"}
	refSecrets    = []string{"app-secret", "db-creds", "regcred", "shared", "tls-cert"}
	refAccounts   = []string{"default", "web", "worker"}
)

func pick(rng *rand.Rand, from []string) string { return from[rng.Intn(len(from))] }

// refPod names ConfigMaps and Secrets in every place a pod can: volumes, projected sources, envFrom and env of its
// containers and init containers, and image pull secrets, with labels and a service account drawn from small sets.
func refPod(rng *rand.Rand, ns string, i int) *corev1.Pod {
	p := randomPod(rng, i)
	p.Namespace = ns
	p.Labels = map[string]string{"app": pick(rng, []string{"web", "api", "db"})}
	if rng.Intn(3) == 0 {
		p.Labels["tier"] = pick(rng, []string{"a", "b", "c"})
	}
	if rng.Intn(5) == 0 {
		p.Labels["canary"] = "true"
	}
	if rng.Intn(6) > 0 {
		p.Spec.ServiceAccountName = pick(rng, refAccounts)
	}
	for v := 0; v < rng.Intn(3); v++ {
		switch rng.Intn(3) {
		case 0:
			p.Spec.Volumes = append(p.Spec.Volumes, corev1.Volume{Name: fmt.Sprint("v", v), VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: pick(rng, refConfigMaps)}}}})
		case 1:
			p.Spec.Volumes = append(p.Spec.Volumes, corev1.Volume{Name: fmt.Sprint("v", v), VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: pick(rng, refSecrets)}}})
		default:
			p.Spec.Volumes = append(p.Spec.Volumes, corev1.Volume{Name: fmt.Sprint("v", v), VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{Sources: []corev1.VolumeProjection{
				{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: pick(rng, refConfigMaps)}}},
				{Secret: &corev1.SecretProjection{LocalObjectReference: corev1.LocalObjectReference{Name: pick(rng, refSecrets)}}},
			}}}})
		}
	}
	env := func(c *corev1.Container) {
		if rng.Intn(3) == 0 {
			c.EnvFrom = append(c.EnvFrom, corev1.EnvFromSource{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: pick(rng, refConfigMaps)}}})
		}
		if rng.Intn(3) == 0 {
			c.EnvFrom = append(c.EnvFrom, corev1.EnvFromSource{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: pick(rng, refSecrets)}}})
		}
		if rng.Intn(3) == 0 {
			c.Env = append(c.Env, corev1.EnvVar{Name: "A", ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: pick(rng, refConfigMaps)}, Key: "k"}}})
		}
		if rng.Intn(3) == 0 {
			c.Env = append(c.Env, corev1.EnvVar{Name: "B", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: pick(rng, refSecrets)}, Key: "k"}}})
		}
	}
	for c := range p.Spec.Containers {
		env(&p.Spec.Containers[c])
	}
	if rng.Intn(4) == 0 {
		p.Spec.InitContainers = []corev1.Container{{Name: "init", Image: "x"}}
		env(&p.Spec.InitContainers[0])
	}
	if rng.Intn(4) == 0 {
		p.Spec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: pick(rng, refSecrets)}}
	}
	return p
}

// drawerCondition is one drawer's table: what it asks the server, and what the drawer kept of the whole list.
type drawerCondition struct {
	name  string
	query PodPageQuery
	keeps func(row map[string]interface{}, p *corev1.Pod) bool
}

func listHolds(row map[string]interface{}, field, name string) bool {
	names, _ := row[field].([]string)
	return slices.Contains(names, name)
}

func drawerConditions(t *testing.T, ns string) []drawerCondition {
	var out []drawerCondition
	for _, cm := range append(slices.Clone(refConfigMaps), "nobody-uses") {
		out = append(out, drawerCondition{"config map " + cm, PodPageQuery{Namespace: ns, ConfigMap: cm},
			func(row map[string]interface{}, _ *corev1.Pod) bool { return listHolds(row, "config_map_refs", cm) }})
	}
	for _, s := range refSecrets {
		out = append(out, drawerCondition{"secret " + s, PodPageQuery{Namespace: ns, Secret: s},
			func(row map[string]interface{}, _ *corev1.Pod) bool { return listHolds(row, "secret_refs", s) }})
	}
	for _, sa := range refAccounts {
		out = append(out, drawerCondition{"service account " + sa, PodPageQuery{Namespace: ns, ServiceAccounts: []string{ns + "/" + sa}},
			func(row map[string]interface{}, _ *corev1.Pod) bool { return row["service_account_name"] == sa }})
	}
	// a RoleBinding names several of the namespace's service accounts
	out = append(out, drawerCondition{"two service accounts", PodPageQuery{Namespace: ns, ServiceAccounts: []string{ns + "/web", ns + "/worker"}},
		func(row map[string]interface{}, _ *corev1.Pod) bool {
			return row["service_account_name"] == "web" || row["service_account_name"] == "worker"
		}})
	for _, text := range []string{"app=web", "app=web,tier in (a,b)", "!canary", "tier", "tier notin (a)", ""} {
		sel, err := labels.Parse(text)
		if err != nil {
			t.Fatal(err)
		}
		q := PodPageQuery{Namespace: ns}
		if text != "" {
			q.LabelSelector = sel
		}
		out = append(out, drawerCondition{"selector " + fmt.Sprintf("%q", text), q,
			func(_ map[string]interface{}, p *corev1.Pod) bool { return sel.Matches(labels.Set(p.Labels)) }})
	}
	return out
}

// Each drawer table's condition answered from the pod rows, read page by page, is what the drawer kept of its
// namespace's whole list: the same pods in the same order with the same cells.
func TestPodPage_TheDrawersConditionsAnswerWhatTheWholeListAnswers(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	in := newInterner()
	var pods []*corev1.Pod
	var rows []*podRow
	for i := 0; i < 3000; i++ {
		ns := []string{"shop", "shop-x", "other"}[rng.Intn(3)]
		p := refPod(rng, ns, i)
		pods = append(pods, p)
		rows = append(rows, toPodRow(p, in))
	}
	// the whole list of a namespace comes in the API's order
	sort.Slice(pods, func(a, b int) bool { return pods[a].Namespace+"/"+pods[a].Name < pods[b].Namespace+"/"+pods[b].Name })
	rng.Shuffle(len(rows), func(a, b int) { rows[a], rows[b] = rows[b], rows[a] })

	for _, c := range drawerConditions(t, "shop") {
		var want []map[string]interface{}
		for _, p := range pods {
			if row := formatPodDetail(p); p.Namespace == "shop" && c.keeps(row, p) {
				want = append(want, row)
			}
		}
		var got []PodListItem
		total := -1
		for offset := 0; ; offset += 10 {
			q := c.query
			q.Offset, q.Limit = offset, 10
			page := buildPodPage(rowsInNamespace(rows, "shop"), q, time.Now())
			if total >= 0 && page.Total != total {
				t.Fatalf("%s: the total moved between pages, %d then %d", c.name, total, page.Total)
			}
			total = page.Total
			got = append(got, page.Items...)
			if len(page.Items) < 10 {
				break
			}
		}
		if total != len(want) || len(got) != len(want) {
			t.Errorf("%s: %d pods on %d rows, the whole list kept %d", c.name, total, len(got), len(want))
			continue
		}
		for i, it := range got {
			w := want[i]
			sa, _ := w["service_account_name"].(string)
			if it.Name != w["name"] || it.Namespace != w["namespace"] || it.Status != w["status"] || it.Phase != w["phase"] ||
				it.Ready != w["ready"] || it.RestartCount != w["restart_count"] || it.NodeName != w["node_name"] ||
				it.CreatedAt != w["created_at"] || it.ServiceAccount != sa {
				t.Errorf("%s: row %d is %+v, the whole list has %v", c.name, i, it, w)
				break
			}
		}
	}
}

// rowsInNamespace is what the informer's namespace index gives a caller of one namespace.
func rowsInNamespace(rows []*podRow, ns string) []*podRow {
	out := make([]*podRow, 0, len(rows))
	for _, r := range rows {
		if r.namespace == ns {
			out = append(out, r)
		}
	}
	return out
}

func usingPod(ns, name, sa string) *corev1.Pod {
	p := overviewPod(ns, name, corev1.PodRunning)
	p.Spec.ServiceAccountName = sa
	p.Spec.Volumes = []corev1.Volume{
		{Name: "c", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "shared"}}}},
		{Name: "s", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: "shared"}}},
	}
	return p
}

// A ConfigMap or Secret of one name in two namespaces: each drawer's condition lists the pods of its own namespace,
// within what the caller may list there and inside a namespace-scoped grant.
func TestGetPodPage_ADrawersConditionKeepsToTheCallersNamespaces(t *testing.T) {
	ctx := context.Background()
	objects := []k8sruntime.Object{usingPod("a", "a1", "app"), usingPod("a", "a2", "app"), usingPod("b", "b1", "app"), overviewPod("b", "b2", corev1.PodRunning)}
	conditions := map[string]func(ns string) PodPageQuery{
		"config map": func(ns string) PodPageQuery { return PodPageQuery{Namespace: ns, ConfigMap: "shared", Limit: 10} },
		"secret":     func(ns string) PodPageQuery { return PodPageQuery{Namespace: ns, Secret: "shared", Limit: 10} },
		"service account": func(ns string) PodPageQuery {
			return PodPageQuery{Namespace: ns, ServiceAccounts: []string{ns + "/app"}, Limit: 10}
		},
	}
	for name, q := range conditions {
		s, _, _ := pageBundle(t, fake.NewSimpleClientset(objects...), func(string) bool { return true })
		for ns, want := range map[string][]string{"a": {"a/a1", "a/a2"}, "b": {"b/b1"}} {
			p, err := s.GetPodPage(ctx, q(ns))
			if err != nil || !reflect.DeepEqual(names(p), want) || p.Total != len(want) {
				t.Fatalf("%s in %s: %v %v", name, ns, p, err)
			}
		}

		// the cluster lets the caller list pods in b only
		s, _, _ = pageBundle(t, fake.NewSimpleClientset(objects...), func(ns string) bool { return ns == "b" })
		if p, err := s.GetPodPage(ctx, q("a")); !apierrors.IsForbidden(err) {
			t.Fatalf("%s in a, refused there: %v %v", name, p, err)
		}
		if p, err := s.GetPodPage(ctx, q("b")); err != nil || !reflect.DeepEqual(names(p), []string{"b/b1"}) {
			t.Fatalf("%s in b: %v %v", name, p, err)
		}

		// a grant limited to namespace a
		scoped := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"a"}}})
		s, _, _ = pageBundle(t, fake.NewSimpleClientset(objects...), func(string) bool { return true })
		if p, err := s.GetPodPage(scoped, q("b")); !apierrors.IsForbidden(err) {
			t.Fatalf("%s in b, outside the grant: %v %v", name, p, err)
		}
		if p, err := s.GetPodPage(scoped, q("a")); err != nil || !reflect.DeepEqual(names(p), []string{"a/a1", "a/a2"}) {
			t.Fatalf("%s in a, inside the grant: %v %v", name, p, err)
		}
	}

	// a ClusterRoleBinding's accounts in both namespaces, asked without one: the grant's namespace only
	scoped := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"a"}}})
	s, _, _ := pageBundle(t, fake.NewSimpleClientset(objects...), func(string) bool { return true })
	p, err := s.GetPodPage(scoped, PodPageQuery{ServiceAccounts: []string{"a/app", "b/app"}, Limit: 10})
	if err != nil || !reflect.DeepEqual(names(p), []string{"a/a1", "a/a2"}) {
		t.Fatalf("service accounts across the grant: %v %v", p, err)
	}
}

// Once the informers hold the rows, a drawer's table and its polls ask the API server nothing, and a poll whose
// revision is current gets "unchanged".
func TestGetPodPage_ADrawersConditionAsksTheAPIServerNothing(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewSimpleClientset(usingPod("a", "a1", "app"), usingPod("a", "a2", "app"))
	s, b, _ := pageBundle(t, cs, func(string) bool { return true })
	if _, err := s.GetPodPage(ctx, PodPageQuery{Namespace: "a", Limit: 10}); err != nil {
		t.Fatal(err)
	}
	ci := b.syncedInformers()
	if ci == nil {
		t.Fatal("the informers did not sync")
	}
	var last string
	eventually(t, 2*time.Second, func() bool { // the handler runs after the store; wait for it to catch up
		cur := ci.podRevision()
		done := cur == last
		last = cur
		time.Sleep(50 * time.Millisecond)
		return done
	})
	cs.ClearActions()
	sel, _ := labels.Parse("app=a1")
	for name, q := range map[string]PodPageQuery{
		"config map":      {Namespace: "a", ConfigMap: "shared", Limit: 10},
		"secret":          {Namespace: "a", Secret: "shared", Limit: 10},
		"service account": {Namespace: "a", ServiceAccounts: []string{"a/app"}, Limit: 10},
		"selector":        {Namespace: "a", LabelSelector: sel, Limit: 10},
	} {
		first, err := s.GetPodPage(ctx, q)
		if err != nil || first.Source != "index" || first.Total == 0 {
			t.Fatalf("%s: %+v %v", name, first, err)
		}
		q.Revision = first.Revision
		again, err := s.GetPodPage(ctx, q)
		if err != nil || !again.Unchanged || len(again.Items) != 0 {
			t.Fatalf("%s with its revision: %+v %v", name, again, err)
		}
	}
	for _, a := range cs.Actions() {
		if a.GetResource().Resource == "pods" && (a.GetVerb() == "list" || a.GetVerb() == "get") {
			t.Fatalf("asked the API server %s %s", a.GetVerb(), a.GetResource().Resource)
		}
	}
}

// A page names the drawer conditions it applied, in a changed answer and an unchanged one alike, so a screen can tell
// it from a server that does not read them.
func TestGetPodPage_SaysWhichDrawerConditionsItApplied(t *testing.T) {
	ctx := context.Background()
	s, _, _ := pageBundle(t, fake.NewSimpleClientset(usingPod("a", "a1", "app")), func(string) bool { return true })
	sel, _ := labels.Parse("app=a1")
	cases := []struct {
		q    PodPageQuery
		want PodPageFilters
	}{
		{PodPageQuery{Namespace: "a", ConfigMap: "shared"}, PodPageFilters{Namespace: "a", ConfigMap: "shared"}},
		{PodPageQuery{Namespace: "a", Secret: "shared"}, PodPageFilters{Namespace: "a", Secret: "shared"}},
		{PodPageQuery{Namespace: "a", ServiceAccounts: []string{"a/app", "a/web"}}, PodPageFilters{Namespace: "a", ServiceAccount: "a/app,a/web"}},
		{PodPageQuery{Namespace: "a", LabelSelector: sel, LabelSelectorText: "app=a1"}, PodPageFilters{Namespace: "a", LabelSelector: "app=a1"}},
		{PodPageQuery{Namespace: "a"}, PodPageFilters{Namespace: "a"}},
		{PodPageQuery{}, PodPageFilters{}},
	}
	for _, c := range cases {
		c.q.Limit = 10
		first, err := s.GetPodPage(ctx, c.q)
		if err != nil || first.Filters != c.want {
			t.Fatalf("%+v: filters %+v, want %+v (%v)", c.q, first.Filters, c.want, err)
		}
		c.q.Revision = first.Revision
		again, err := s.GetPodPage(ctx, c.q)
		if err != nil || !again.Unchanged || again.Filters != c.want {
			t.Fatalf("%+v unchanged: %+v, want filters %+v (%v)", c.q, again, c.want, err)
		}
	}
	body, err := json.Marshal(&PodPage{})
	if err != nil || !strings.Contains(string(body), `"filters":{}`) {
		t.Fatalf("an answer always carries its filters, empty or not: %s", body)
	}
}

// The ConfigMap and Secret names a row keeps for these tables cost little: a set's pods name the same ones, kept once.
func TestPodRowMemory_WithReferences(t *testing.T) {
	if testing.Short() {
		t.Skip("allocates 50 000 rows")
	}
	const n = 50_000
	rng := rand.New(rand.NewSource(5))
	in := newInterner()
	idx := cache.NewIndexer(cache.DeletionHandlingMetaNamespaceKeyFunc, cache.Indexers{cache.NamespaceIndex: cache.MetaNamespaceIndexFunc})
	add := func(i int) {
		p := typicalPod(rng, i)
		if err := idx.Add(toPodRow(p, in)); err != nil {
			t.Fatal(err)
		}
	}
	add(0)
	before := heapInUse()
	for i := 1; i <= n; i++ {
		add(i)
	}
	after := heapInUse()
	runtime.KeepAlive(idx)
	per := float64(after-before) / n
	t.Logf("%.0f bytes per pod with its references (%d pods: %.1f MiB)", per, n, float64(after-before)/(1<<20))
	if per > podRowMaxBytes {
		t.Errorf("a pod with references costs %.0f bytes in the index, more than %d", per, podRowMaxBytes)
	}
}

// typicalPod is a Deployment's pod as a cluster has it: the service account token's projected volume, a ConfigMap
// mounted and one in the environment, a Secret in the environment and an image pull secret.
func typicalPod(rng *rand.Rand, i int) *corev1.Pod {
	app := fmt.Sprintf("service-%04d", i/50)
	rs := app + "-5f7b9c8d6"
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: "bulk", Name: fmt.Sprintf("%s-%s", rs, randSuffix(rng)),
			UID: "0b6b2f4e-6c2a-4c55-9a3e-2f1d8e7c5a10", ResourceVersion: fmt.Sprint(10_000_000 + i),
			CreationTimestamp: metav1.Now(),
			OwnerReferences:   []metav1.OwnerReference{{Kind: "ReplicaSet", Name: rs, Controller: ptrTo(true)}},
			Labels:            map[string]string{"app": app, "pod-template-hash": "5f7b9c8d6"},
		},
		Spec: corev1.PodSpec{
			NodeName: fmt.Sprintf("ip-10-0-%d-%d.ap-northeast-2.compute.internal", i%1000/250, i%250), ServiceAccountName: app,
			Volumes: []corev1.Volume{
				{Name: "kube-api-access", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{Sources: []corev1.VolumeProjection{
					{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "kube-root-ca.crt"}}},
				}}}},
				{Name: "conf", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: app + "-conf"}}}},
			},
			ImagePullSecrets: []corev1.LocalObjectReference{{Name: "regcred"}},
			Containers: []corev1.Container{{Name: "app", Image: "registry.example.com/team/service:1.2.3",
				EnvFrom: []corev1.EnvFromSource{
					{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: app + "-env"}}},
					{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: app + "-secret"}}},
				}}},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, PodIP: fmt.Sprintf("10.1.%d.%d", i/250%250, i%250),
			ContainerStatuses: []corev1.ContainerStatus{{Name: "app", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}},
	}
}

// One drawer's condition over a namespace of 50 000 pod rows: the time and memory of one answer.
func BenchmarkPodPage_ADrawersConditionIn50000Pods(b *testing.B) {
	rng := rand.New(rand.NewSource(9))
	in := newInterner()
	rows := make([]*podRow, 0, 50_000)
	for i := 0; i < 50_000; i++ {
		rows = append(rows, toPodRow(typicalPod(rng, i), in))
	}
	sel, _ := labels.Parse("app=service-0007")
	for name, q := range map[string]PodPageQuery{
		"config map used by 50":     {Namespace: "bulk", ConfigMap: "service-0007-conf", Limit: 10},
		"config map used by all":    {Namespace: "bulk", ConfigMap: "kube-root-ca.crt", Limit: 10},
		"secret":                    {Namespace: "bulk", Secret: "service-0007-secret", Limit: 10},
		"service account":           {Namespace: "bulk", ServiceAccounts: []string{"bulk/service-0007"}, Limit: 10},
		"selector":                  {Namespace: "bulk", LabelSelector: sel, Limit: 10},
		"empty selector (all pods)": {Namespace: "bulk", Limit: 10},
	} {
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				page := buildPodPage(rows, q, time.Now())
				if page.Total == 0 {
					b.Fatal("no pod matched")
				}
			}
		})
	}
}

// fatPod is a pod of three containers with thirty environment entries, ports, mounts and limits each.
func fatPod(i int) *corev1.Pod {
	p := typicalPod(rand.New(rand.NewSource(int64(i))), i)
	base := p.Spec.Containers[0]
	p.Spec.Containers = nil
	for c := 0; c < 3; c++ {
		ct := base
		ct.Name = fmt.Sprint("c", c)
		for e := 0; e < 30; e++ {
			ct.Env = append(ct.Env, corev1.EnvVar{Name: fmt.Sprintf("SETTING_%02d", e), Value: "a value of some length for the setting"})
		}
		ct.Ports = []corev1.ContainerPort{{Name: "http", ContainerPort: 8080, Protocol: corev1.ProtocolTCP}, {Name: "metrics", ContainerPort: 9090, Protocol: corev1.ProtocolTCP}}
		ct.VolumeMounts = []corev1.VolumeMount{{Name: "conf", MountPath: "/etc/app"}, {Name: "kube-api-access", MountPath: "/var/run/secrets/kubernetes.io/serviceaccount", ReadOnly: true}}
		ct.Resources = corev1.ResourceRequirements{
			Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("128Mi")},
			Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1"), corev1.ResourceMemory: resource.MustParse("512Mi")},
		}
		ct.Command = []string{"/app/server", "--config", "/etc/app/config.yaml"}
		p.Spec.Containers = append(p.Spec.Containers, ct)
		p.Status.ContainerStatuses = append(p.Status.ContainerStatuses, corev1.ContainerStatus{Name: ct.Name, Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.Now()}}})
	}
	return p
}

// What the whole-namespace read a drawer made costs k8s-service per size: the rows it holds and the JSON it builds
// before writing (GetPods and response.JSON). Run with POD_TABLE_COST=1; it sets where a table stops following live.
func TestWholeNamespacePodReadCost(t *testing.T) {
	if os.Getenv("POD_TABLE_COST") == "" {
		t.Skip("set POD_TABLE_COST=1 to measure")
	}
	for _, kind := range []string{"typical", "fat"} {
		for _, n := range []int{500, 1000, 2000, 5000, 10_000, 50_000} {
			if kind == "fat" && n > 10_000 {
				continue // the pods themselves would take the laptop's memory
			}
			pods := make([]*corev1.Pod, n)
			rng := rand.New(rand.NewSource(1))
			for i := range pods {
				if kind == "fat" {
					pods[i] = fatPod(i)
				} else {
					pods[i] = typicalPod(rng, i)
				}
			}
			before := heapInUse()
			var m0, m1 runtime.MemStats
			runtime.ReadMemStats(&m0)
			rows := make([]map[string]interface{}, 0)
			for _, p := range pods {
				rows = append(rows, formatPodDetail(p))
			}
			runtime.ReadMemStats(&m1)
			held := heapInUse() - before
			t.Logf("%s %6d pods: building the rows allocated %6.1f MiB", kind, n, float64(m1.TotalAlloc-m0.TotalAlloc)/(1<<20))
			start := time.Now()
			body, err := json.Marshal(rows)
			if err != nil {
				t.Fatal(err)
			}
			took := time.Since(start)
			runtime.KeepAlive(rows)
			t.Logf("%s %6d pods: rows held %6.1f MiB, JSON %6.1f MiB (encode %v), together %6.1f MiB, %.1f KiB a pod",
				kind, n, float64(held)/(1<<20), float64(len(body))/(1<<20), took.Round(time.Millisecond),
				float64(held+uint64(len(body)))/(1<<20), float64(held+uint64(len(body)))/float64(n)/1024)
		}
	}

	// the API server's side of one whole read, as GetPods asks it
	api := &pagedPods{perNamespace: 50_000}
	rows := 0
	if err := eachPod(context.Background(), api.client(t).CoreV1(), "big-bulk", metav1.ListOptions{}, func(p *corev1.Pod) {
		_ = formatPodDetail(p)
		rows++
	}); err != nil {
		t.Fatal(err)
	}
	t.Logf("one whole read of a 50 000-pod namespace: %d rows in %d list requests", rows, 1+api.laterRequests.Load())
}
