package k8s

import (
	"context"
	"encoding/json"
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

// The row's Status is kubectl's (kubectlPrintPod) and its other columns are what
// the page showed from the full pod map, for every combination the generator draws.
func TestPodRow_MatchesThePagesOldColumns(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	in := newInterner()
	for i := 0; i < 5000; i++ {
		p := randomPod(rng, i)
		m := formatPodDetail(p)
		r := toPodRow(p, in)
		it := r.item()
		if want := kubectlStatus(p); it.Status != want {
			t.Fatalf("pod %d status = %q, kubectl prints %q (%+v, deleted %v)", i, it.Status, want, p.Status, p.DeletionTimestamp != nil)
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

// kubectlCards counts the state cards from what kubectl prints, a pod in one card: Error first (the phase Failed or a
// status naming an error), then Terminating as kubectl's STATUS says it, then the phase; Ready the Running pods with
// every container ready and Not Ready what is left, which is every pod no other card names. Restarted is what a pod
// went through, not a state, and adds to no sum. The top statuses are the page's: the most common first, ties in the
// API's order.
func kubectlCards(pods []*corev1.Pod) PodStats {
	st := PodStats{Total: len(pods), TopReasons: []PodReasonCount{}}
	counts := map[string]int{}
	var order []string
	for _, p := range pods {
		status := kubectlStatus(p)
		_, readyCell, restarts := kubectlPrintPod(p)
		phase := string(p.Status.Phase)
		if phase == "" {
			phase = status
		}
		var ready, total int
		fmt.Sscanf(readyCell, "%d/%d", &ready, &total)
		if restarts > 0 {
			st.Restarted++
		}
		switch {
		case phase == "Failed" || statusNamesError(status):
			st.Error++
		case status == "Terminating":
			st.Terminating++
		case phase == "Pending":
			st.Pending++
		case phase == "Succeeded":
			st.Completed++
		case phase == "Running" && p.DeletionTimestamp == nil && total > 0 && ready == total:
			st.Ready++
		default:
			st.NotReady++
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

// A pod is in one of the six state cards, so they add up to the total; Restarted is apart.
func podCardSum(s PodStats) int {
	return s.Ready + s.NotReady + s.Pending + s.Terminating + s.Error + s.Completed
}

// The summary cards and the top statuses are what kubectl's columns count over the
// API's list (in its order), they add up to the total and do not change with the search.
func TestPodStats_EachPodInOneCard(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	in := newInterner()
	var pods []*corev1.Pod
	for i := 0; i < 3000; i++ {
		if i%2 == 0 {
			pods = append(pods, randomPod(rng, i))
		} else {
			pods = append(pods, randomPrintPod(rng, i))
		}
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
	rng.Shuffle(len(rows), func(a, b int) { rows[a], rows[b] = rows[b], rows[a] }) // the store's order is a map's
	got := buildPodPage(rows, PodPageQuery{Search: "team-01", Limit: 10}, time.Now())
	if sum := podCardSum(got.Stats); sum != len(pods) {
		t.Errorf("the cards add up to %d of %d pods: %+v", sum, len(pods), got.Stats)
	}
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
	if want := kubectlCards(byKey); !reflect.DeepEqual(got.Stats, want) {
		t.Fatalf("stats\n got %+v\nwant %+v", got.Stats, want)
	}
}

// 51 of a Deployment's pods being replaced read as Terminating, not as 51 more ready ones next to their new pods; the
// card each state lands in, and the sum, whichever states the namespace holds.
func TestPodStats_TerminatingIsItsOwnCard(t *testing.T) {
	now := metav1.Now()
	running := corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
	pod := func(i int, phase corev1.PodPhase, ready bool, state corev1.ContainerState, mod func(p *corev1.Pod)) *corev1.Pod {
		p := overviewPod("a", fmt.Sprintf("p-%03d", i), phase)
		p.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "c", Ready: ready, State: state}}
		if mod != nil {
			mod(p)
		}
		return p
	}
	deleted := func(p *corev1.Pod) { p.DeletionTimestamp = &now }
	waiting := func(r string) corev1.ContainerState {
		return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: r}}
	}
	done := func(code int32, r string) corev1.ContainerState {
		return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: code, Reason: r}}
	}
	in := newInterner()
	var rows []*podRow
	add := func(n int, mk func(i int) *corev1.Pod) {
		for i := 0; i < n; i++ {
			rows = append(rows, toPodRow(mk(len(rows)), in))
		}
	}
	add(51, func(i int) *corev1.Pod { return pod(i, corev1.PodRunning, true, running, deleted) })
	add(100, func(i int) *corev1.Pod { return pod(i, corev1.PodRunning, true, running, nil) })
	add(2, func(i int) *corev1.Pod { return pod(i, corev1.PodRunning, false, running, deleted) })
	add(3, func(i int) *corev1.Pod {
		return pod(i, corev1.PodPending, false, waiting("ContainerCreating"), deleted)
	})
	add(4, func(i int) *corev1.Pod { return pod(i, corev1.PodRunning, false, waiting("CrashLoopBackOff"), deleted) })
	add(5, func(i int) *corev1.Pod { return pod(i, corev1.PodRunning, false, running, nil) })
	add(6, func(i int) *corev1.Pod { return pod(i, corev1.PodPending, false, waiting("ContainerCreating"), nil) })
	add(7, func(i int) *corev1.Pod { return pod(i, corev1.PodRunning, false, waiting("CrashLoopBackOff"), nil) })
	add(8, func(i int) *corev1.Pod { return pod(i, corev1.PodPending, false, waiting("ImagePullBackOff"), nil) })
	add(9, func(i int) *corev1.Pod { return pod(i, corev1.PodFailed, false, done(1, "Error"), deleted) })
	add(10, func(i int) *corev1.Pod { return pod(i, corev1.PodSucceeded, false, done(0, "Completed"), deleted) })
	add(11, func(i int) *corev1.Pod { return pod(i, corev1.PodSucceeded, false, done(0, "Completed"), nil) })
	add(12, func(i int) *corev1.Pod { return pod(i, corev1.PodUnknown, false, corev1.ContainerState{}, nil) })
	add(13, func(i int) *corev1.Pod {
		return pod(i, corev1.PodRunning, true, running, func(p *corev1.Pod) { deleted(p); p.Status.Reason = "NodeLost" })
	})
	st := podStats(rows)
	st.TopReasons, st.Health = nil, PodHealthCounts{}
	want := PodStats{
		Total:       len(rows),
		Ready:       100,
		NotReady:    5 + 12 + 13, // Running not ready, then the phase Unknown and a lost node's pod being deleted: kubectl's Unknown
		Pending:     6,
		Terminating: 51 + 2 + 3 + 4,
		Error:       7 + 8 + 9,
		Completed:   10 + 11,
	}
	if !reflect.DeepEqual(st, want) {
		t.Errorf("cards\n got %+v\nwant %+v", st, want)
	}
	if sum := podCardSum(st); sum != len(rows) {
		t.Errorf("the cards add up to %d of %d pods", sum, len(rows))
	}
}

// A grant limited to namespaces counts the pods being deleted in those namespaces only; the answer names the card
// the page draws.
func TestGetPodPage_TerminatingCountsOnlyTheCallersPods(t *testing.T) {
	now := metav1.Now()
	going := func(ns, name string) *corev1.Pod {
		p := overviewPod(ns, name, corev1.PodRunning)
		p.DeletionTimestamp = &now
		return p
	}
	objects := func() []k8sruntime.Object {
		return []k8sruntime.Object{going("a", "p1"), overviewPod("a", "p2", corev1.PodRunning), going("b", "p3"), going("b", "p4"), going("c", "p5")}
	}
	ctx := context.Background()
	s, _, _ := pageBundle(t, fake.NewSimpleClientset(objects()...), func(string) bool { return true })
	p, err := s.GetPodPage(ctx, PodPageQuery{Limit: 50})
	if err != nil || p.Stats.Terminating != 4 || p.Stats.Total != 5 {
		t.Fatalf("every namespace: %+v %v", p, err)
	}
	body, err := json.Marshal(p.Stats)
	if err != nil || !strings.Contains(string(body), `"terminating":4`) {
		t.Fatalf("the answer: %s %v", body, err)
	}
	// the grant names a and c; the cluster lets it list a only
	scoped := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"a", "c"}}})
	s, _, _ = pageBundle(t, fake.NewSimpleClientset(objects()...), func(ns string) bool { return ns == "a" })
	p, err = s.GetPodPage(scoped, PodPageQuery{Limit: 50})
	if err != nil || p.Stats.Terminating != 1 || p.Stats.Total != 2 || podCardSum(p.Stats) != 2 {
		t.Fatalf("scoped: %+v %v", p, err)
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

// Without init containers or a pod-level limit, a pod's limits are the containers' sums, and none when a container
// sets none (Monitoring Pods' limit columns).
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
		// a limit of 0 is none (the Monitoring page's former podLimit), units add up
		{[]corev1.Container{ctr("0", "170Mi")}, -1, 170 << 20},
		{[]corev1.Container{ctr("500m", "256Mi"), ctr("1.5", "1Gi")}, 2000, (256 + 1024) << 20},
		{nil, -1, -1},
	} {
		cpu, mem := podLimits(&corev1.Pod{Spec: corev1.PodSpec{Containers: c.containers}})
		if cpu != c.cpu || mem != c.mem {
			t.Errorf("%d containers: cpu %d mem %d, want %d %d", len(c.containers), cpu, mem, c.cpu, c.mem)
		}
	}
}

func TestPodLimits_AsTheKubeletSizesTheCgroup(t *testing.T) {
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
	always := corev1.ContainerRestartPolicyAlways
	sidecar := func(cpu, mem string) corev1.Container {
		c := ctr(cpu, mem)
		c.RestartPolicy = &always
		return c
	}
	podLevel := func(cpu, mem string) *corev1.ResourceRequirements {
		r := ctr(cpu, mem).Resources
		return &r
	}
	for _, c := range []struct {
		name       string
		init, apps []corev1.Container
		pod        *corev1.ResourceRequirements
		cpu, mem   int64
	}{
		{"sidecar added", []corev1.Container{sidecar("200m", "128Mi")}, []corev1.Container{ctr("500m", "256Mi")}, nil, 700, 384 << 20},
		{"init container at its peak", []corev1.Container{ctr("2", "1Gi")}, []corev1.Container{ctr("500m", "256Mi")}, nil, 2000, 1 << 30},
		// a sidecar started before an init container runs next to it
		{"sidecar then init", []corev1.Container{sidecar("300m", "64Mi"), ctr("1", "512Mi")}, []corev1.Container{ctr("500m", "256Mi")}, nil, 1300, 576 << 20},
		{"init then sidecar", []corev1.Container{ctr("1", "512Mi"), sidecar("300m", "64Mi")}, []corev1.Container{ctr("500m", "256Mi")}, nil, 1000, 512 << 20},
		{"init container without a limit", []corev1.Container{ctr("", "")}, []corev1.Container{ctr("500m", "256Mi")}, nil, -1, -1},
		{"sidecar without a cpu limit", []corev1.Container{sidecar("", "64Mi")}, []corev1.Container{ctr("500m", "256Mi")}, nil, -1, 320 << 20},
		{"pod-level limit", nil, []corev1.Container{ctr("", ""), ctr("500m", "")}, podLevel("3", "2Gi"), 3000, 2 << 30},
		{"pod-level cpu only", nil, []corev1.Container{ctr("500m", "256Mi"), ctr("", "")}, podLevel("1", ""), 1000, -1},
	} {
		p := &corev1.Pod{Spec: corev1.PodSpec{InitContainers: c.init, Containers: c.apps, Resources: c.pod}}
		cpu, mem := podLimits(p)
		if cpu != c.cpu || mem != c.mem {
			t.Errorf("%s: cpu %d mem %d, want %d %d", c.name, cpu, mem, c.cpu, c.mem)
		}
	}
}

// The dashboard's Unknown bar counts a pod with no phase yet as Unknown (overviewFor), so the list it opens
// (phase=Unknown) has those pods too; the other phases are only their own.
func TestBuildPodPage_UnknownPhaseHasThePodsWithoutAPhase(t *testing.T) {
	now := time.Unix(1_700_001_000, 0)
	rows := []*podRow{
		row("a", "running", nil),
		row("a", "lost", func(r *podRow) { r.phase = "Unknown"; r.status = "Unknown" }),
		row("a", "new", func(r *podRow) { r.phase = ""; r.status = "ContainerCreating" }),
	}
	if got := names(buildPodPage(rows, PodPageQuery{Phase: "Unknown", Limit: 50}, now)); !reflect.DeepEqual(got, []string{"a/lost", "a/new"}) {
		t.Errorf("phase=Unknown lists %v, want a/lost and a/new", got)
	}
	if got := names(buildPodPage(rows, PodPageQuery{Phase: "Running", Limit: 50}, now)); !reflect.DeepEqual(got, []string{"a/running"}) {
		t.Errorf("phase=Running lists %v", got)
	}
}
