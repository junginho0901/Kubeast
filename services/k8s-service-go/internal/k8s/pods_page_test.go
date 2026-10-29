package k8s

import (
	"context"
	"fmt"
	"math/rand"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/cache"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// podRowMaxBytes is what one pod may cost in the index: the row, its strings,
// the store entry and the namespace index entry. 100 000 pods ≈ 60 MB.
const podRowMaxBytes = 600

// podRowUniqueLabelsMaxBytes is the same for a pod whose labels are its own (a StatefulSet's).
const podRowUniqueLabelsMaxBytes = 750

// randomPod makes a pod of a Deployment with container states drawn from what
// kubelet writes, so the row's status can be compared with the page's old
// computation.
func randomPod(rng *rand.Rand, i int) *corev1.Pod {
	ns := fmt.Sprintf("team-%02d", rng.Intn(12))
	if rng.Intn(10) == 0 {
		ns = "team" // a namespace that is a prefix of the others
	}
	rs := fmt.Sprintf("app-%03d-7d9f8c6b5", rng.Intn(40))
	phases := []corev1.PodPhase{corev1.PodRunning, corev1.PodRunning, corev1.PodRunning, corev1.PodPending, corev1.PodSucceeded, corev1.PodFailed, corev1.PodUnknown, ""}
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns, Name: fmt.Sprintf("%s-%05d", rs, i), ResourceVersion: fmt.Sprint(1000 + i),
			CreationTimestamp: metav1.NewTime(time.Unix(1_700_000_000+int64(rng.Intn(1_000_000)), 0)),
			OwnerReferences:   []metav1.OwnerReference{{Kind: "ReplicaSet", Name: rs, Controller: ptrTo(true)}},
		},
		Spec:   corev1.PodSpec{NodeName: fmt.Sprintf("node-%03d", rng.Intn(30))},
		Status: corev1.PodStatus{Phase: phases[rng.Intn(len(phases))], PodIP: fmt.Sprintf("10.0.%d.%d", rng.Intn(4), rng.Intn(250))},
	}
	if rng.Intn(20) == 0 {
		p.Status.Reason = "Evicted"
	}
	if rng.Intn(15) == 0 {
		p.DeletionTimestamp = &metav1.Time{Time: time.Unix(1_701_000_000, 0)}
	}
	for c := 0; c < 1+rng.Intn(3); c++ {
		name := fmt.Sprintf("c%d", c)
		p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: name, Image: "x"})
		if rng.Intn(8) == 0 {
			continue // no status yet
		}
		cs := corev1.ContainerStatus{Name: name, Ready: rng.Intn(3) > 0, RestartCount: int32(rng.Intn(3) * rng.Intn(4))}
		switch rng.Intn(6) {
		case 0:
			cs.State.Waiting = &corev1.ContainerStateWaiting{Reason: []string{"CrashLoopBackOff", "ImagePullBackOff", "ContainerCreating", "ErrImagePull"}[rng.Intn(4)]}
		case 1:
			cs.State.Terminated = &corev1.ContainerStateTerminated{Reason: []string{"Completed", "Error", "OOMKilled"}[rng.Intn(3)]}
		case 2:
			cs.State.Waiting = &corev1.ContainerStateWaiting{} // waiting without a reason
		default:
			cs.State.Running = &corev1.ContainerStateRunning{}
		}
		// statuses do not always come in spec order
		if rng.Intn(4) == 0 {
			p.Status.ContainerStatuses = append([]corev1.ContainerStatus{cs}, p.Status.ContainerStatuses...)
		} else {
			p.Status.ContainerStatuses = append(p.Status.ContainerStatuses, cs)
		}
	}
	return p
}

func ptrTo[T any](v T) *T { return &v }

// oldDisplayStatus is the page's pickPodDisplayStatus (podHelpers.ts) over
// formatPodDetail's map, as the Pods list worked it out before the rows.
func oldDisplayStatus(m map[string]interface{}) string {
	if r, _ := m["status_reason"].(string); r != "" {
		return r
	}
	var reasons []string
	for _, c := range m["containers"].([]map[string]interface{}) {
		st, _ := c["state"].(map[string]interface{})
		if w, ok := st["waiting"].(map[string]interface{}); ok {
			if r, _ := w["reason"].(string); r != "" {
				reasons = append(reasons, r)
			}
		}
		if t, ok := st["terminated"].(map[string]interface{}); ok {
			if r, _ := t["reason"].(string); r != "" {
				reasons = append(reasons, r)
			}
		}
	}
	if len(reasons) > 0 {
		return reasons[0]
	}
	phase, _ := m["phase"].(string)
	if phase == "" {
		phase, _ = m["status"].(string)
	}
	if phase == "" {
		phase = "Unknown"
	}
	if phase == "Running" {
		var ready, total int
		fmt.Sscanf(m["ready"].(string), "%d/%d", &ready, &total)
		if total > 0 && ready != total {
			return "NotReady"
		}
	}
	return phase
}

// The row's status, ready and restarts are what the page showed from the full
// pod map, for every combination the generator draws.
func TestPodRow_MatchesThePagesOldColumns(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	in := newInterner()
	for i := 0; i < 5000; i++ {
		p := randomPod(rng, i)
		m := formatPodDetail(p)
		r := toPodRow(p, in)
		it := r.item()
		if want := oldDisplayStatus(m); it.Status != want {
			t.Fatalf("pod %d status = %q, the page showed %q (%+v)", i, it.Status, want, p.Status)
		}
		if it.Ready != m["ready"] || it.RestartCount != m["restart_count"] || it.NodeName != m["node_name"] ||
			it.PodIP != m["pod_ip"] || it.CreatedAt != m["created_at"] || it.Phase != m["phase"] {
			t.Fatalf("pod %d item %+v, the map had %v", i, it, m)
		}
		if (p.DeletionTimestamp != nil) != (it.DeletionTimestamp != "") || (p.DeletionTimestamp != nil && it.DeletionTimestamp != m["deletion_timestamp"]) {
			t.Fatalf("pod %d deletion %q, the map had %v", i, it.DeletionTimestamp, m["deletion_timestamp"])
		}
		if r.ownerKind != "ReplicaSet" || r.ownerName != p.OwnerReferences[0].Name {
			t.Fatalf("pod %d owner %s/%s", i, r.ownerKind, r.ownerName)
		}
	}
}

// oldStats is the page's podStats (Pods.tsx) over formatPodDetail's maps.
func oldStats(maps []map[string]interface{}) PodStats {
	st := PodStats{Total: len(maps), TopReasons: []PodReasonCount{}}
	counts := map[string]int{}
	var order []string
	for _, m := range maps {
		phase, _ := m["phase"].(string)
		if phase == "" {
			phase, _ = m["status"].(string)
		}
		if phase == "" {
			phase = "Unknown"
		}
		status := oldDisplayStatus(m)
		var ready, total int
		fmt.Sscanf(m["ready"].(string), "%d/%d", &ready, &total)
		if phase == "Pending" {
			st.Pending++
		}
		if m["restart_count"].(int32) > 0 {
			st.Restarted++
		}
		if phase == "Succeeded" {
			st.Completed++
		}
		if phase == "Running" && total > 0 && ready == total {
			st.Ready++
		} else if phase == "Running" {
			st.NotReady++
		}
		if phase == "Failed" || statusNamesError(status) {
			st.Error++
		}
		if counts[status] == 0 {
			order = append(order, status)
		}
		counts[status]++
	}
	sort.SliceStable(order, func(a, b int) bool { return counts[order[a]] > counts[order[b]] })
	for _, s := range order[:min(4, len(order))] {
		st.TopReasons = append(st.TopReasons, PodReasonCount{Reason: s, Count: counts[s]})
	}
	return st
}

// The summary cards and the top statuses are what the page counted from the
// API's list (in its order), and do not change with the search.
func TestPodStats_MatchThePagesOldCounts(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	in := newInterner()
	var pods []*corev1.Pod
	for i := 0; i < 3000; i++ {
		pods = append(pods, randomPod(rng, i))
	}
	rows := make([]*podRow, len(pods))
	for i, p := range pods {
		rows[i] = toPodRow(p, in)
	}
	// the API's order, for the old count's ties
	byKey := make([]*corev1.Pod, len(pods))
	copy(byKey, pods)
	sort.Slice(byKey, func(a, b int) bool {
		return byKey[a].Namespace+"/"+byKey[a].Name < byKey[b].Namespace+"/"+byKey[b].Name
	})
	maps := make([]map[string]interface{}, len(byKey))
	for i, p := range byKey {
		maps[i] = formatPodDetail(p)
	}
	rng.Shuffle(len(rows), func(a, b int) { rows[a], rows[b] = rows[b], rows[a] }) // the store's order is a map's
	got := buildPodPage(rows, PodPageQuery{Search: "team-01", Limit: 10}, time.Now())
	// the card colour counts came after the page's counts: each pod in one colour, as podHealth gives it
	health := PodHealthCounts{}
	for _, p := range pods {
		switch h, _ := podHealth(p); h {
		case podHealthOK:
			health.OK++
		case podHealthWarn:
			health.Warn++
		default:
			health.Error++
		}
	}
	if got.Stats.Health != health {
		t.Fatalf("health counts %+v, want %+v", got.Stats.Health, health)
	}
	got.Stats.Health = PodHealthCounts{}
	if want := oldStats(maps); !reflect.DeepEqual(got.Stats, want) {
		t.Fatalf("stats\n got %+v\nwant %+v", got.Stats, want)
	}
}

func row(ns, name string, mod func(r *podRow)) *podRow {
	r := &podRow{namespace: ns, name: name, phase: "Running", status: "Running", ready: 1, containers: 1, created: 1_700_000_000}
	if mod != nil {
		mod(r)
	}
	return r
}

func names(p *PodPage) []string {
	out := make([]string, len(p.Items))
	for i, it := range p.Items {
		out[i] = it.Namespace + "/" + it.Name
	}
	return out
}

// Search, sort, ties and the cut, as the page did them in the browser.
func TestBuildPodPage_SearchSortAndCut(t *testing.T) {
	now := time.Unix(1_700_001_000, 0)
	rows := []*podRow{
		row("b", "web-2", func(r *podRow) { r.node = "node-a"; r.podIP = "10.0.0.12"; r.restarts = 3; r.created = 1_700_000_500 }),
		row("a-x", "web-1", func(r *podRow) { r.node = "node-b"; r.podIP = "10.0.0.9" }),
		row("a", "web-1", func(r *podRow) { r.node = "node-b"; r.podIP = "10.0.0.2"; r.status = "CrashLoopBackOff"; r.ready = 0 }),
		row("a", "db-0", func(r *podRow) {
			r.node = "node-c"
			r.status = "ContainerCreating"
			r.phase = "Pending"
			r.ready = 0
			r.created = 0
		}),
		row("b", "Job-1", func(r *podRow) { r.status = "Completed"; r.phase = "Succeeded"; r.ready = 0 }),
	}
	cases := []struct {
		q    PodPageQuery
		want []string
		tot  int
	}{
		// the API's order: "a-x/…" before "a/…" ('-' < '/')
		{PodPageQuery{}, []string{"a-x/web-1", "a/db-0", "a/web-1", "b/Job-1", "b/web-2"}, 5},
		{PodPageQuery{Search: "WEB"}, []string{"a-x/web-1", "a/web-1", "b/web-2"}, 3},
		{PodPageQuery{Search: "node-b"}, []string{"a-x/web-1", "a/web-1"}, 2},
		{PodPageQuery{Search: "10.0.0.1"}, []string{"b/web-2"}, 1},
		{PodPageQuery{Search: "a-x"}, []string{"a-x/web-1"}, 1},
		// ties (web-1 twice) stay in the API's order, also descending
		{PodPageQuery{Sort: "name"}, []string{"a/db-0", "b/Job-1", "a-x/web-1", "a/web-1", "b/web-2"}, 5},
		{PodPageQuery{Sort: "name", Desc: true}, []string{"b/web-2", "a-x/web-1", "a/web-1", "b/Job-1", "a/db-0"}, 5},
		{PodPageQuery{Sort: "status"}, []string{"b/Job-1", "a/db-0", "a/web-1", "a-x/web-1", "b/web-2"}, 5},
		{PodPageQuery{Sort: "restarts", Desc: true}, []string{"b/web-2", "a-x/web-1", "a/db-0", "a/web-1", "b/Job-1"}, 5},
		{PodPageQuery{Sort: "ready"}, []string{"a/db-0", "a/web-1", "b/Job-1", "a-x/web-1", "b/web-2"}, 5},
		// strings compare character by character, as localeCompare: "10.0.0.12" < "10.0.0.2"
		{PodPageQuery{Sort: "pod_ip"}, []string{"a/db-0", "b/Job-1", "b/web-2", "a/web-1", "a-x/web-1"}, 5},
		// age: no creation time reads as 0 s (ageSeconds), the youngest first
		{PodPageQuery{Sort: "age"}, []string{"a/db-0", "b/web-2", "a-x/web-1", "a/web-1", "b/Job-1"}, 5},
		{PodPageQuery{Sort: "node_name", Offset: 1, Limit: 2}, []string{"b/web-2", "a-x/web-1"}, 5},
		{PodPageQuery{Offset: 9, Limit: 2}, []string{}, 5},
	}
	for _, c := range cases {
		got := buildPodPage(rows, c.q, now)
		if n := names(got); !reflect.DeepEqual(n, c.want) || got.Total != c.tot {
			t.Errorf("%+v: got %v (total %d), want %v (total %d)", c.q, n, got.Total, c.want, c.tot)
		}
		if got.Stats.Total != 5 {
			t.Errorf("%+v: stats over %d rows, want the 5 of the namespace choice", c.q, got.Stats.Total)
		}
	}
}

// A pod costs at most podRowMaxBytes in the index, for 100 000 pods spread
// like a large cluster's (Deployments of 50, 1 000 nodes).
func TestPodRowMemory(t *testing.T) {
	if testing.Short() {
		t.Skip("allocates 100 000 rows")
	}
	const n = 100_000
	rng := rand.New(rand.NewSource(3))
	in := newInterner()
	idx := cache.NewIndexer(cache.DeletionHandlingMetaNamespaceKeyFunc, cache.Indexers{cache.NamespaceIndex: cache.MetaNamespaceIndexFunc})
	add := func(i int) {
		rs := fmt.Sprintf("service-%04d-5f7b9c8d6", i/50)
		p := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Namespace: fmt.Sprintf("team-%03d", i/1000), Name: fmt.Sprintf("%s-%s", rs, randSuffix(rng)),
				UID: "0b6b2f4e-6c2a-4c55-9a3e-2f1d8e7c5a10", ResourceVersion: fmt.Sprint(10_000_000 + i),
				CreationTimestamp: metav1.Now(),
				OwnerReferences:   []metav1.OwnerReference{{Kind: "ReplicaSet", Name: rs, Controller: ptrTo(true)}},
				Labels:            map[string]string{"app": rs, "pod-template-hash": "5f7b9c8d6"},
			},
			Spec: corev1.PodSpec{NodeName: fmt.Sprintf("ip-10-0-%d-%d.ap-northeast-2.compute.internal", i%1000/250, i%250),
				Containers: []corev1.Container{{Name: "app", Image: "registry.example.com/team/service:1.2.3"}}},
			Status: corev1.PodStatus{Phase: corev1.PodRunning, PodIP: fmt.Sprintf("10.1.%d.%d", i/250%250, i%250),
				ContainerStatuses: []corev1.ContainerStatus{{Name: "app", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}},
		}
		if err := idx.Add(toPodRow(p, in)); err != nil {
			t.Fatal(err)
		}
	}
	add(0) // the interner's and the maps' first allocations are not per pod
	before := heapInUse()
	for i := 1; i <= n; i++ {
		add(i)
	}
	after := heapInUse()
	runtime.KeepAlive(idx)
	if got := len(idx.ListKeys()); got != n+1 {
		t.Fatalf("index has %d rows", got)
	}
	per := float64(after-before) / n
	t.Logf("%.0f bytes per pod (%d pods: %.1f MiB)", per, n, float64(after-before)/(1<<20))
	if per > podRowMaxBytes {
		t.Errorf("a pod costs %.0f bytes in the index, more than %d", per, podRowMaxBytes)
	}
}

// A StatefulSet's pods each carry labels of their own (pod-name, pod-index), which the row keeps for the word
// search: they cost what those labels take, at most podRowUniqueLabelsMaxBytes with the ones a StatefulSet sets.
func TestPodRowMemory_LabelsOfTheirOwn(t *testing.T) {
	if testing.Short() {
		t.Skip("allocates 50 000 rows")
	}
	const n = 50_000
	in := newInterner()
	idx := cache.NewIndexer(cache.DeletionHandlingMetaNamespaceKeyFunc, cache.Indexers{cache.NamespaceIndex: cache.MetaNamespaceIndexFunc})
	add := func(i int) {
		sts := fmt.Sprintf("service-%04d", i/50)
		name := fmt.Sprintf("%s-%d", sts, i%50)
		p := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Namespace: fmt.Sprintf("team-%03d", i/1000), Name: name, GenerateName: sts + "-",
				UID: "0b6b2f4e-6c2a-4c55-9a3e-2f1d8e7c5a10", ResourceVersion: fmt.Sprint(10_000_000 + i),
				CreationTimestamp: metav1.Now(),
				OwnerReferences:   []metav1.OwnerReference{{Kind: "StatefulSet", Name: sts, Controller: ptrTo(true)}},
				Labels: map[string]string{"app": sts, "controller-revision-hash": sts + "-6d8f7b9c5d",
					"statefulset.kubernetes.io/pod-name": name, "apps.kubernetes.io/pod-index": fmt.Sprint(i % 50)},
			},
			Spec: corev1.PodSpec{NodeName: fmt.Sprintf("ip-10-0-%d-%d.ap-northeast-2.compute.internal", i%1000/250, i%250),
				Containers: []corev1.Container{{Name: "app", Image: "registry.example.com/team/service:1.2.3"}}},
			Status: corev1.PodStatus{Phase: corev1.PodRunning, PodIP: fmt.Sprintf("10.1.%d.%d", i/250%250, i%250),
				ContainerStatuses: []corev1.ContainerStatus{{Name: "app", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}},
		}
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
	t.Logf("%.0f bytes per StatefulSet pod (%d pods: %.1f MiB)", per, n, float64(after-before)/(1<<20))
	if per > podRowUniqueLabelsMaxBytes {
		t.Errorf("a StatefulSet pod costs %.0f bytes in the index, more than %d", per, podRowUniqueLabelsMaxBytes)
	}
}

func heapInUse() uint64 {
	runtime.GC()
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

func randSuffix(rng *rand.Rand) string {
	const chars = "bcdfghjklmnpqrstvwxz2456789"
	b := make([]byte, 5)
	for i := range b {
		b[i] = chars[rng.Intn(len(chars))]
	}
	return string(b)
}

// pageBundle is a bundle whose informers watch cs and whose caller's reviews
// answer allow(namespace).
func pageBundle(t *testing.T, cs *fake.Clientset, allow func(namespace string) bool) (*Service, *clientBundle, *int) {
	t.Helper()
	reviews := 0
	authz := fake.NewSimpleClientset()
	authz.PrependReactor("create", "selfsubjectaccessreviews", func(a k8stesting.Action) (bool, k8sruntime.Object, error) {
		reviews++
		ra := a.(k8stesting.CreateAction).GetObject().(*authorizationv1.SelfSubjectAccessReview).Spec.ResourceAttributes
		if ra.Verb != "list" || ra.Resource != "pods" {
			return true, nil, fmt.Errorf("unexpected review %+v", ra)
		}
		return true, &authorizationv1.SelfSubjectAccessReview{Status: authorizationv1.SubjectAccessReviewStatus{Allowed: allow(ra.Namespace)}}, nil
	})
	s := &Service{}
	b := &clientBundle{cacheClient: cs, authz: authz.AuthorizationV1()}
	s.defaultBundle.Store(b)
	t.Cleanup(func() { _ = b.Close() })
	return s, b, &reviews
}

func pagePods() []k8sruntime.Object {
	return []k8sruntime.Object{
		overviewPod("a", "p1", corev1.PodRunning),
		overviewPod("a", "p2", corev1.PodPending),
		overviewPod("b", "p3", corev1.PodRunning),
		overviewPod("c", "p4", corev1.PodFailed),
	}
}

// A caller who may list pods everywhere is paged from the informer; one who
// may only in some namespaces gets those, asked of the cluster as the caller;
// one who may not gets the cluster's refusal.
func TestGetPodPage_AccessFromTheCallersIdentity(t *testing.T) {
	ctx := context.Background()

	s, _, _ := pageBundle(t, fake.NewSimpleClientset(pagePods()...), func(string) bool { return true })
	p, err := s.GetPodPage(ctx, PodPageQuery{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if p.Source != "index" || p.Total != 4 || p.Stats.Pending != 1 || p.Revision == "" {
		t.Fatalf("all: %+v", p)
	}

	// only namespace b: every namespace is refused, b is allowed
	s, _, reviews := pageBundle(t, fake.NewSimpleClientset(pagePods()...), func(ns string) bool { return ns == "b" })
	if _, err := s.GetPodPage(ctx, PodPageQuery{Limit: 50}); !apierrors.IsForbidden(err) {
		t.Fatalf("every namespace without the right: %v", err)
	}
	p, err = s.GetPodPage(ctx, PodPageQuery{Namespace: "b", Limit: 50})
	if err != nil || !reflect.DeepEqual(names(p), []string{"b/p3"}) || p.Stats.Total != 1 {
		t.Fatalf("namespace b: %v %v", p, err)
	}
	if _, err := s.GetPodPage(ctx, PodPageQuery{Namespace: "a", Limit: 50}); !apierrors.IsForbidden(err) {
		t.Fatalf("namespace a: %v", err)
	}
	if *reviews == 0 {
		t.Fatal("the caller's identity was never asked")
	}

	// a namespace-scoped grant: its namespaces the cluster allows, nothing outside them
	scoped := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"a", "c"}}})
	s, _, _ = pageBundle(t, fake.NewSimpleClientset(pagePods()...), func(ns string) bool { return ns == "a" })
	p, err = s.GetPodPage(scoped, PodPageQuery{Limit: 50})
	if err != nil || !reflect.DeepEqual(names(p), []string{"a/p1", "a/p2"}) {
		t.Fatalf("scoped: %v %v", p, err)
	}
	if _, err := s.GetPodPage(scoped, PodPageQuery{Namespace: "b", Limit: 50}); !apierrors.IsForbidden(err) {
		t.Fatalf("scoped, outside the grant: %v", err)
	}
	if _, err := s.GetPodPage(scoped, PodPageQuery{Namespace: "c", Limit: 50}); !apierrors.IsForbidden(err) {
		t.Fatalf("scoped, refused by the cluster: %v", err)
	}
}

// The revision stays while nothing a row shows changes, so a poll gets
// "unchanged" and no rows; a change a row shows moves it.
func TestGetPodPage_Revision(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewSimpleClientset(pagePods()...)
	s, b, _ := pageBundle(t, cs, func(string) bool { return true })
	first, err := s.GetPodPage(ctx, PodPageQuery{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	ci := b.syncedInformers()
	settle := func() string { // the handler runs after the store; wait for it to catch up
		var last string
		eventually(t, 2*time.Second, func() bool {
			cur := ci.podRevision()
			done := cur == last
			last = cur
			time.Sleep(50 * time.Millisecond)
			return done
		})
		return last
	}
	settle()
	first, _ = s.GetPodPage(ctx, PodPageQuery{Limit: 50})
	again, err := s.GetPodPage(ctx, PodPageQuery{Limit: 50, Revision: first.Revision})
	if err != nil || !again.Unchanged || again.Items == nil || len(again.Items) != 0 || again.Revision != first.Revision {
		t.Fatalf("same revision: %+v %v", again, err)
	}

	// a new resourceVersion with nothing shown changing (a condition's heartbeat)
	p1, _ := cs.CoreV1().Pods("a").Get(ctx, "p1", metav1.GetOptions{})
	p1.ResourceVersion = "999"
	p1.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue, LastProbeTime: metav1.Now()}}
	if _, err := cs.CoreV1().Pods("a").UpdateStatus(ctx, p1, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if !eventually(t, 2*time.Second, func() bool {
		o, _, _ := ci.pods.GetByKey("a/p1")
		return o.(*podRow).rv == "999"
	}) {
		t.Fatal("the update never reached the store")
	}
	settle()
	again, _ = s.GetPodPage(ctx, PodPageQuery{Limit: 50, Revision: first.Revision})
	if !again.Unchanged {
		t.Fatalf("a heartbeat moved the revision: %+v", again)
	}

	// a status the list shows
	p1, _ = cs.CoreV1().Pods("a").Get(ctx, "p1", metav1.GetOptions{})
	p1.Status.Phase = corev1.PodFailed
	if _, err := cs.CoreV1().Pods("a").UpdateStatus(ctx, p1, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if !eventually(t, 2*time.Second, func() bool {
		p, _ := s.GetPodPage(ctx, PodPageQuery{Limit: 50, Revision: first.Revision})
		return !p.Unchanged && p.Stats.Error == 2
	}) {
		t.Fatal("a shown change did not move the revision")
	}

	// a new informer set (the old one stopped when idle) never matches the old revision
	_ = b.Close()
	p, err := s.GetPodPage(ctx, PodPageQuery{Limit: 50, Revision: first.Revision})
	if err != nil || p.Unchanged {
		t.Fatalf("after a restart: %+v %v", p, err)
	}
}

// Until the informer can serve, the rows are listed as the caller in chunks:
// every namespace, one namespace, or a scoped grant's namespaces; the result
// is the same page.
func TestListPodRows_ChunksAndScope(t *testing.T) {
	ctx := context.Background()
	var objs []k8sruntime.Object
	for i := 0; i < 1203; i++ {
		objs = append(objs, overviewPod([]string{"a", "b", "c"}[i%3], fmt.Sprintf("p%04d", i), corev1.PodRunning))
	}
	cs := fake.NewSimpleClientset(objs...)
	var limits []int64
	cs.PrependReactor("list", "pods", func(a k8stesting.Action) (bool, k8sruntime.Object, error) {
		limits = append(limits, a.(k8stesting.ListActionImpl).GetListOptions().Limit)
		return false, nil, nil
	})
	rows, err := listPodRows(ctx, cs.CoreV1(), nil)
	if err != nil || len(rows) != 1203 {
		t.Fatalf("every namespace: %d %v", len(rows), err)
	}
	if len(limits) == 0 || limits[0] != podListChunk {
		t.Fatalf("list limits %v, want %d", limits, podListChunk)
	}
	rows, err = listPodRows(ctx, cs.CoreV1(), []string{"c", "a"})
	if err != nil || len(rows) != 802 || rows[0].namespace != "c" {
		t.Fatalf("scope c, a: %d %v", len(rows), err)
	}

	// a namespace the cluster refuses is skipped; all refused is the refusal
	cs.PrependReactor("list", "pods", func(a k8stesting.Action) (bool, k8sruntime.Object, error) {
		if a.GetNamespace() == "b" {
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "", fmt.Errorf("no"))
		}
		return false, nil, nil
	})
	rows, err = listPodRows(ctx, cs.CoreV1(), []string{"a", "b"})
	if err != nil || len(rows) != 401 {
		t.Fatalf("a with b refused: %d %v", len(rows), err)
	}
	if _, err := listPodRows(ctx, cs.CoreV1(), []string{"b"}); !apierrors.IsForbidden(err) {
		t.Fatalf("only b: %v", err)
	}
}

func TestPodRow_SameViewIgnoresResourceVersion(t *testing.T) {
	a := row("a", "p", func(r *podRow) { r.rv = "1" })
	b := row("a", "p", func(r *podRow) { r.rv = "2" })
	if !a.sameView(b) {
		t.Error("rows differing in resourceVersion only must show the same")
	}
	b.restarts = 1
	if a.sameView(b) {
		t.Error("a new restart count must count as a change")
	}
	if !strings.HasPrefix((&clusterInformers{epoch: "e"}).podRevision(), "e-") {
		t.Error("the revision must carry the informer set's epoch")
	}
}

// The Resource Graph's group list: one owner's pods, counted by card colour, filtered by one, problems first.
func TestPodPage_OwnerHealthFilterAndProblemsFirst(t *testing.T) {
	own := func(kind, name string, health uint8) func(r *podRow) {
		return func(r *podRow) { r.ownerKind, r.ownerName, r.health = kind, name, health }
	}
	rows := []*podRow{
		row("shop", "web-a", own("ReplicaSet", "web-rs", podHealthOK)),
		row("shop", "web-b", own("ReplicaSet", "web-rs", podHealthError)),
		row("shop", "web-c", own("ReplicaSet", "web-rs", podHealthWarn)),
		row("shop", "web-d", own("ReplicaSet", "web-rs", podHealthOK)),
		row("shop", "api-a", own("ReplicaSet", "api-rs", podHealthError)),
	}
	mine := rowsOfOwner(rows, "ReplicaSet", "web-rs")
	if len(mine) != 4 || len(rowsOfOwner(rows, "", "")) != 5 || len(rowsOfOwner(rows, "StatefulSet", "web-rs")) != 0 {
		t.Fatalf("owner rows = %d", len(mine))
	}
	page := buildPodPage(mine, PodPageQuery{Sort: "health", Limit: 50}, time.Now())
	if want := []string{"shop/web-b", "shop/web-c", "shop/web-a", "shop/web-d"}; !reflect.DeepEqual(names(page), want) {
		t.Fatalf("problems first = %v, want %v", names(page), want)
	}
	if page.Stats.Health != (PodHealthCounts{OK: 2, Warn: 1, Error: 1}) || page.Stats.Total != 4 {
		t.Fatalf("stats = %+v", page.Stats)
	}
	page = buildPodPage(mine, PodPageQuery{Health: "ok", Limit: 50}, time.Now())
	if want := []string{"shop/web-a", "shop/web-d"}; !reflect.DeepEqual(names(page), want) || page.Total != 2 || page.Stats.Total != 4 {
		t.Fatalf("health=ok: %v total %d stats %d — the summary counts before the filter", names(page), page.Total, page.Stats.Total)
	}
}

// The drawers' and the Dashboard window's filters: phase, RuntimeClass, PriorityClass and the service accounts a
// ClusterRoleBinding binds; the summary counts before them.
func TestPodPage_PhaseClassAndServiceAccountFilters(t *testing.T) {
	rows := []*podRow{
		row("a", "p1", func(r *podRow) { r.runtimeClass, r.priorityClass, r.serviceAccount = "gvisor", "high", "app" }),
		row("a", "p2", func(r *podRow) { r.phase, r.priorityClass, r.serviceAccount = "Pending", "high", "other" }),
		row("b", "p3", func(r *podRow) { r.runtimeClass, r.serviceAccount = "gvisor", "app" }),
		row("b", "p4", nil),
	}
	cases := []struct {
		q    PodPageQuery
		want []string
	}{
		{PodPageQuery{Phase: "Pending"}, []string{"a/p2"}},
		{PodPageQuery{RuntimeClass: "gvisor"}, []string{"a/p1", "b/p3"}},
		{PodPageQuery{PriorityClass: "high"}, []string{"a/p1", "a/p2"}},
		{PodPageQuery{ServiceAccounts: []string{"a/app", "b/app"}}, []string{"a/p1", "b/p3"}},
		{PodPageQuery{ServiceAccounts: []string{"a/app"}}, []string{"a/p1"}},
	}
	for _, c := range cases {
		c.q.Limit = 50
		page := buildPodPage(rows, c.q, time.Now())
		if !reflect.DeepEqual(names(page), c.want) || page.Total != len(c.want) || page.Stats.Total != 4 {
			t.Errorf("%+v: %v total %d stats %d", c.q, names(page), page.Total, page.Stats.Total)
		}
	}
	if it := buildPodPage(rows, PodPageQuery{ServiceAccounts: []string{"a/app"}, Limit: 50}, time.Now()).Items[0]; it.ServiceAccount != "app" {
		t.Fatalf("the row names its service account: %+v", it)
	}
}

// A pod's limits are the containers' sums, and none when a container sets none (Monitoring Pods' rule).
func TestPodLimits(t *testing.T) {
	ctr := func(cpu, mem string) corev1.Container {
		c := corev1.Container{Name: "c", Resources: corev1.ResourceRequirements{Limits: corev1.ResourceList{}}}
		if cpu != "" {
			c.Resources.Limits[corev1.ResourceCPU] = resource.MustParse(cpu)
		}
		if mem != "" {
			c.Resources.Limits[corev1.ResourceMemory] = resource.MustParse(mem)
		}
		return c
	}
	for _, c := range []struct {
		containers []corev1.Container
		cpu, mem   int64
	}{
		{[]corev1.Container{ctr("500m", "256Mi"), ctr("1", "1Gi")}, 1500, (256 + 1024) << 20},
		{[]corev1.Container{ctr("500m", "256Mi"), ctr("", "1Gi")}, -1, (256 + 1024) << 20},
		{[]corev1.Container{ctr("500m", "")}, 500, -1},
		{nil, -1, -1},
	} {
		cpu, mem := podLimits(&corev1.Pod{Spec: corev1.PodSpec{Containers: c.containers}})
		if cpu != c.cpu || mem != c.mem {
			t.Errorf("%d containers: cpu %d mem %d, want %d %d", len(c.containers), cpu, mem, c.cpu, c.mem)
		}
	}
}
