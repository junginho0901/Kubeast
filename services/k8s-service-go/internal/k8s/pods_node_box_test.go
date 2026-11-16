package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/tools/cache"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/podrow"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

func podObjects(pods []corev1.Pod) []k8sruntime.Object {
	out := make([]k8sruntime.Object, len(pods))
	for i := range pods {
		out[i] = &pods[i]
	}
	return out
}

func decodeBox(t testing.TB, raw []byte) []nodeBoxPod {
	t.Helper()
	var pods []nodeBoxPod
	if err := json.Unmarshal(raw, &pods); err != nil {
		t.Fatalf("answer %q: %v", raw, err)
	}
	return pods
}

// ownBox is the caller's own list of node's pods as a box draws them.
func ownBox(t testing.TB, ctx context.Context, b *clientBundle, node, namespace string) []nodeBoxPod {
	t.Helper()
	namespaces, err := callerNamespaces(ctx, namespace)
	if err != nil {
		t.Fatal(err)
	}
	parts, err := listNodePodsOfCaller(ctx, b.id, b.clientset.CoreV1(), node, namespaces, boxPodsOf)
	if err != nil {
		t.Fatalf("the caller's own list: %v", err)
	}
	return append([]nodeBoxPod{}, slices.Concat(parts...)...)
}

func podLists(api *clusterAPI) int {
	return api.count(func(c apiCall) bool { return c.verb == "list" && c.resource == "pods" })
}

// listedSince is the namespaces of the lists of pods the cluster saw after its first n requests.
func (a *clusterAPI) listedSince(n int) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for _, c := range a.calls[n:] {
		if c.verb == "list" && c.resource == "pods" {
			out = append(out, c.user+" "+c.namespace+" "+c.selector)
		}
	}
	slices.Sort(out)
	return out
}

func (a *clusterAPI) seen() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.calls)
}

// A pod in a box says what its full row says, field for field, with the colour and reason the page's getPodHealth gives
// the full row (podHealth).
func TestABoxPodSaysWhatItsFullRowSays(t *testing.T) {
	in := newInterner()
	levels := map[uint8]string{podHealthOK: "ok", podHealthWarn: "warn", podHealthError: "error"}
	check := func(p *corev1.Pod) {
		t.Helper()
		raw, err := json.Marshal(boxPodOf(toPodRow(p, in)))
		if err != nil {
			t.Fatal(err)
		}
		var box map[string]interface{}
		_ = json.Unmarshal(raw, &box)
		fullRaw, _ := json.Marshal(podrow.Info(p))
		var full map[string]interface{}
		_ = json.Unmarshal(fullRaw, &full)
		level, reason := podHealth(p)
		for k, v := range box {
			switch k {
			case "health":
				if v != levels[level] {
					t.Fatalf("%s/%s health %v, podHealth %s", p.Namespace, p.Name, v, levels[level])
				}
			case "health_reason":
				if v != reason {
					t.Fatalf("%s/%s reason %v, podHealth %s", p.Namespace, p.Name, v, reason)
				}
			default:
				if fv, ok := full[k]; !ok || !reflect.DeepEqual(fv, v) {
					t.Fatalf("%s/%s %s: box %#v, full row %#v", p.Namespace, p.Name, k, v, fv)
				}
			}
		}
		if len(box) != 11 {
			t.Fatalf("%d fields: %v", len(box), box)
		}
	}
	for seed, gen := range []func(*rand.Rand, int) *corev1.Pod{randomPod, randomHealthPod, randomSidecarPod, randomPrintPod, typicalPod} {
		rng := rand.New(rand.NewSource(int64(seed + 11)))
		for i := 0; i < 400; i++ {
			check(gen(rng, i))
		}
	}
	unscheduled := nodePod("a", "a-pending", "")
	unscheduled.CreationTimestamp = metav1.Time{}
	check(&unscheduled)
}

// A box's pods are what the caller's own list of the node shows, in every way a caller asks, from the informers' rows:
// no list of pods is made but those of a namespace the caller's access check refuses.
func TestNodeBoxesAreWhatTheCallersOwnListShows(t *testing.T) {
	grants := map[string][]string{"wide@example.com": {""}, "ac@example.com": {"a", "c"}, "b@example.com": {"b"}, "inb@example.com": {"b"}, "hook@example.com": {"a"}}
	review := rbac(grants)
	pods := podsOnNodes()
	api := &clusterAPI{pods: pods, review: review, may: func(user, verb, resource, namespace, selector string) bool {
		if user == overviewCacheUser {
			return true
		}
		// an authorizer that reads the selector: hook may list b's pods of a node, which a review without it refuses
		if user == "hook@example.com" && resource == "pods" && namespace == "b" && selector != "" {
			return true
		}
		return review(user, authorizationv1.ResourceAttributes{Verb: verb, Resource: resource, Namespace: namespace})
	}}
	s, b := api.start(t, podObjects(pods)...)
	cases := []struct {
		name            string
		ctx             context.Context
		node, namespace string
		lists           []string
		want            int
	}{
		{"every namespace", wideCaller("wide@example.com"), "n1", "", nil, 6},
		{"one namespace chosen", wideCaller("wide@example.com"), "n1", "c", nil, 2},
		{"not scheduled", wideCaller("wide@example.com"), "", "", nil, 1},
		{"a node with none", wideCaller("wide@example.com"), "n9", "", nil, 0},
		{"a grant of two namespaces", grantCaller("ac@example.com", "c", "a"), "n1", "", nil, 4},
		{"a grant of one namespace", grantCaller("b@example.com", "b"), "n2", "", nil, 1},
		{"one namespace allowed of a wide grant", wideCaller("inb@example.com"), "n1", "b", nil, 2},
		// b and c, which the review refuses, are asked of the cluster as the person: it lets the node's list of b through
		{"a namespace the check refuses", grantCaller("hook@example.com", "a", "b", "c"), "n1", "",
			[]string{"hook@example.com b spec.nodeName=n1", "hook@example.com c spec.nodeName=n1"}, 4},
	}
	for _, c := range cases {
		before := api.seen()
		raw, err := s.GetPodsOnNodeJSON(c.ctx, c.node, c.namespace)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := api.listedSince(before); !slices.Equal(got, c.lists) {
			t.Errorf("%s: lists of pods %v, want %v", c.name, got, c.lists)
		}
		got := decodeBox(t, raw)
		want := ownBox(t, c.ctx, b, c.node, c.namespace)
		if len(want) != c.want {
			t.Fatalf("%s: the caller's own list has %d pods, the case says %d", c.name, len(want), c.want)
		}
		if answerJSON(t, got) != answerJSON(t, want) {
			t.Errorf("%s:\n got %s\nwant %s", c.name, answerJSON(t, got), answerJSON(t, want))
		}
		if string(raw) != string(boxJSON(want)) {
			t.Errorf("%s: answer %q", c.name, raw)
		}
	}
	if n := api.count(func(c apiCall) bool { return c.user == overviewCacheUser }); n != 0 {
		t.Errorf("%d reads as %s", n, overviewCacheUser)
	}
	if _, err := s.GetPodsOnNodeJSON(grantCaller("b@example.com", "b"), "n1", "a"); !apierrors.IsForbidden(err) {
		t.Errorf("a namespace outside the grant: %v", err)
	}
	if _, err := s.GetPodsOnNodeJSON(wideCaller("none@example.com"), "n1", ""); !apierrors.IsForbidden(err) {
		t.Errorf("a caller with no right: %v", err)
	}
}

// Four hundred people opening four hundred different nodes' boxes at one moment make no list of pods: each box is the
// rows of its node, kept to what each caller may list.
func TestFourHundredPeopleOpeningFourHundredNodesListNoPods(t *testing.T) {
	pods, grants := manyNodes(400)
	for i := 0; i < 400; i += 5 {
		grants[fmt.Sprintf("u%02d@example.com", i)] = []string{"a"}
	}
	api := &clusterAPI{pods: pods, review: rbac(grants)}
	s, b := api.start(t, podObjects(pods)...)
	caller := func(i int) context.Context {
		u := fmt.Sprintf("u%02d@example.com", i)
		if i%5 == 0 {
			return grantCaller(u, "a")
		}
		return wideCaller(u)
	}
	answers := make([][]byte, 400)
	errs := make([]error, 400)
	var wg sync.WaitGroup
	for i := range 400 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i], errs[i] = s.GetPodsOnNodeJSON(caller(i), fmt.Sprintf("n%02d", i), "")
		}()
	}
	wg.Wait()
	lists := podLists(api)
	t.Logf("400 people, 400 nodes: %d lists of pods", lists)
	if lists != 0 {
		t.Errorf("%d lists of pods, want 0", lists)
	}
	for i := range 400 {
		want := ownBox(t, caller(i), b, fmt.Sprintf("n%02d", i), "")
		if errs[i] != nil || answerJSON(t, decodeBox(t, answers[i])) != answerJSON(t, want) || len(want) != map[bool]int{true: 1, false: 2}[i%5 == 0] {
			t.Errorf("node %d: %s, %v; the caller's own list %d pods", i, answers[i], errs[i], len(want))
		}
	}
}

// Before the informers serve — not started, not yet synced, or stopped because kubeast:cache may not watch pods — a
// box is the caller's own list of its node; it neither waits for the informers nor uses them (a wait or a read of
// them marks their last use, waitSynced and nodeRows), and no informer is started for it.
func TestNodeBoxesAreTheCallersOwnListUntilTheInformersServe(t *testing.T) {
	unsynced := func() *clusterInformers {
		return &clusterInformers{stop: make(chan struct{}), synced: make(chan struct{})}
	}
	cases := map[string]func(b *clientBundle){
		"not started":    func(b *clientBundle) { b.inf = nil },
		"not yet synced": func(b *clientBundle) { b.inf = unsynced() },
		"stopped":        func(b *clientBundle) { b.inf.stopNow() },
	}
	for _, name := range []string{"not started", "not yet synced", "stopped"} {
		t.Run(name, func(t *testing.T) {
			pods := podsOnNodes()
			api := &clusterAPI{pods: pods, review: rbac(map[string][]string{"wide@example.com": {""}, "ac@example.com": {"a", "c"}})}
			// the informers hold another pod than the cluster has: an answer from them would show it
			s, b := api.start(t, podObjects([]corev1.Pod{nodePod("a", "a-informer-only", "n1")})...)
			cases[name](b)
			used := func() int64 {
				if b.inf == nil {
					return -1
				}
				return b.inf.lastUse.Load()
			}
			for _, ctx := range []context.Context{wideCaller("wide@example.com"), grantCaller("ac@example.com", "a", "c")} {
				before := used()
				raw, err := s.GetPodsOnNodeJSON(ctx, "n1", "")
				if err != nil {
					t.Fatal(err)
				}
				if after := used(); after != before {
					t.Errorf("the informers were waited for or read: last use %d, then %d", before, after)
				}
				want := ownBox(t, ctx, b, "n1", "")
				if len(want) == 0 || answerJSON(t, decodeBox(t, raw)) != answerJSON(t, want) {
					t.Errorf("got %s, the caller's own list %d pods", raw, len(want))
				}
			}
			if name == "not started" && b.inf != nil {
				t.Error("an informer was started for a box")
			}
			if n := api.count(func(c apiCall) bool { return c.user == overviewCacheUser }); n != 0 {
				t.Errorf("%d reads as %s", n, overviewCacheUser)
			}
		})
	}
}

// What a box listed as each caller costs the API server is bounded as the drawers' reads are: sixty people opening
// sixty nodes' boxes when the rows cannot answer them — informers not yet serving, or a grant's namespace its own access
// check refuses — are read sixteen at a time, and each gets its own list.
func TestNodeBoxesListedAsTheCallerTakeTheNodeReadPlaces(t *testing.T) {
	for _, name := range []string{"informers not serving", "a namespace the access check refuses"} {
		t.Run(name, func(t *testing.T) {
			pods, grants := manyNodes(60)
			api := &clusterAPI{pods: pods, review: rbac(grants), holdCallers: make(chan struct{})}
			s, b := api.start(t, podObjects(pods)...)
			caller := func(i int) context.Context { return wideCaller(fmt.Sprintf("u%02d@example.com", i)) }
			if name == "informers not serving" {
				b.inf = nil
			} else {
				api.review = rbac(map[string][]string{})
				api.may = func(string, string, string, string, string) bool { return true }
				caller = func(i int) context.Context { return grantCaller(fmt.Sprintf("u%02d@example.com", i), "a") }
			}
			answers := make([][]byte, 60)
			errs := make([]error, 60)
			var wg sync.WaitGroup
			for i := range 60 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					answers[i], errs[i] = s.GetPodsOnNodeJSON(caller(i), fmt.Sprintf("n%02d", i), "")
				}()
			}
			eventually(t, 5*time.Second, func() bool { now, _ := api.callerReads(); return now >= nodeReadsAtOnce })
			time.Sleep(300 * time.Millisecond)
			_, most := api.callerReads()
			close(api.holdCallers)
			wg.Wait()
			t.Logf("60 boxes at once: %d read as their callers at the same time", most)
			if most > nodeReadsAtOnce || most == 0 {
				t.Errorf("%d node reads as the callers at once, want 1 to %d", most, nodeReadsAtOnce)
			}
			for i := range 60 {
				if errs[i] != nil || len(decodeBox(t, answers[i])) == 0 {
					t.Errorf("node %d: %s, %v", i, answers[i], errs[i])
				}
			}
		})
	}
}

// servingInformers are synced informers over a fake cluster holding pods, which the test changes.
func servingInformers(t *testing.T, pods []corev1.Pod) (*clusterInformers, *fake.Clientset) {
	t.Helper()
	cs := fake.NewSimpleClientset(podObjects(pods)...)
	ci := newClusterInformers(cs, time.Hour, nil)
	t.Cleanup(ci.stopNow)
	if !ci.waitSynced(context.Background(), 5*time.Second) {
		t.Fatal("informers did not sync")
	}
	return ci, cs
}

func boxNames(t testing.TB, raw []byte) []string {
	t.Helper()
	var out []string
	for _, p := range decodeBox(t, raw) {
		out = append(out, p.Namespace+"/"+p.Name+" "+p.Phase+" "+p.Health)
	}
	return out
}

// A pod that changes, moves to another node, comes or goes is in the boxes as the informer has it next: the index and
// a node's kept answer follow.
func TestNodeBoxesFollowThePodsAsTheyChangeMoveAndGo(t *testing.T) {
	pods := podsOnNodes()
	api := &clusterAPI{pods: pods, review: rbac(map[string][]string{"wide@example.com": {""}, "ac@example.com": {"a", "c"}})}
	s, b := api.start(t)
	ci, cs := servingInformers(t, pods)
	b.inf = ci
	wide, scoped := wideCaller("wide@example.com"), grantCaller("ac@example.com", "a", "c")
	box := func(ctx context.Context, node string) []string {
		raw, err := s.GetPodsOnNodeJSON(ctx, node, "")
		if err != nil {
			t.Fatal(err)
		}
		return boxNames(t, raw)
	}
	follows := func(what string, want map[string][]string) {
		t.Helper()
		ok := eventually(t, 5*time.Second, func() bool {
			for node, names := range want {
				if !slices.Equal(box(wide, node), names) {
					return false
				}
			}
			return true
		})
		if !ok {
			for node, names := range want {
				t.Errorf("%s: %s got %v, want %v", what, node, box(wide, node), names)
			}
		}
	}
	follows("as listed", map[string][]string{
		"n1": {"a/a-db-0 Running ok", "a/a-web-1 Running ok", "b/b-db-0 Running ok", "b/b-web-1 Running ok", "c/c-db-0 Running ok", "c/c-web-1 Running ok"},
		"n2": {"a/a-web-2 Running ok", "b/b-web-2 Running ok", "c/c-web-2 Running ok"},
	})
	pods2 := func(ns, name string) *corev1.Pod {
		p, err := cs.CoreV1().Pods(ns).Get(context.Background(), name, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	ctx := context.Background()
	moved := pods2("a", "a-web-1")
	moved.Spec.NodeName, moved.ResourceVersion = "n2", "2"
	if _, err := cs.CoreV1().Pods("a").Update(ctx, moved, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	failed := pods2("c", "c-db-0")
	failed.Status.Phase, failed.ResourceVersion = corev1.PodFailed, "3"
	if _, err := cs.CoreV1().Pods("c").Update(ctx, failed, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := cs.CoreV1().Pods("b").Delete(ctx, "b-db-0", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	added := nodePod("c", "c-new", "n1")
	if _, err := cs.CoreV1().Pods("c").Create(ctx, &added, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	want1 := []string{"a/a-db-0 Running ok", "b/b-web-1 Running ok", "c/c-db-0 Failed error", "c/c-new Running ok", "c/c-web-1 Running ok"}
	want2 := []string{"a/a-web-1 Running ok", "a/a-web-2 Running ok", "b/b-web-2 Running ok", "c/c-web-2 Running ok"}
	follows("changed, moved, gone and come", map[string][]string{"n1": want1, "n2": want2})
	if got, want := box(scoped, "n1"), []string{"a/a-db-0 Running ok", "c/c-db-0 Failed error", "c/c-new Running ok", "c/c-web-1 Running ok"}; !slices.Equal(got, want) {
		t.Errorf("a grant of a and c on n1: %v, want %v", got, want)
	}
	if got := box(wide, "n9"); len(got) != 0 {
		t.Errorf("a node with none: %v", got)
	}
}

// The box of a node is made once for everyone who may see every namespace while its rows stay the same, and anew once
// one of them changes; at most nodeBoxesKept nodes are kept.
func TestANodesBoxIsMadeOnceUntilItsRowsChange(t *testing.T) {
	pods := podsOnNodes()
	api := &clusterAPI{pods: pods, review: rbac(map[string][]string{"one@example.com": {""}, "two@example.com": {""}})}
	s, b := api.start(t)
	ci, cs := servingInformers(t, pods)
	b.inf = ci
	first, err := s.GetPodsOnNodeJSON(wideCaller("one@example.com"), "n2", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.GetPodsOnNodeJSON(wideCaller("two@example.com"), "n2", "")
	if err != nil {
		t.Fatal(err)
	}
	if &first[0] != &second[0] {
		t.Error("two people got answers made twice")
	}
	other, _ := s.GetPodsOnNodeJSON(wideCaller("two@example.com"), "n1", "")
	if &other[0] == &first[0] {
		t.Fatal("two nodes share an answer")
	}
	p, err := cs.CoreV1().Pods("b").Get(context.Background(), "b-web-2", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	p.Status.Phase, p.ResourceVersion = corev1.PodPending, "2"
	if _, err := cs.CoreV1().Pods("b").Update(context.Background(), p, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	var third []byte
	if !eventually(t, 5*time.Second, func() bool {
		third, _ = s.GetPodsOnNodeJSON(wideCaller("one@example.com"), "n2", "")
		return slices.Contains(boxNames(t, third), "b/b-web-2 Pending warn")
	}) {
		t.Fatalf("the changed pod never showed: %s", third)
	}
	for i := 0; i < nodeBoxesKept+20; i++ {
		_, _ = s.GetPodsOnNodeJSON(wideCaller("one@example.com"), fmt.Sprintf("x%03d", i), "")
	}
	ci.boxes.mu.Lock()
	kept := len(ci.boxes.nodes)
	ci.boxes.mu.Unlock()
	if kept > nodeBoxesKept {
		t.Errorf("%d nodes' answers kept, want at most %d", kept, nodeBoxesKept)
	}
}

// The kept answers hold at most nodeBoxesKeepBytes, which the count of their bytes says, and a node whose answer alone
// is past it is answered and not kept.
func TestTheKeptBoxesHoldAtMostTheirBytes(t *testing.T) {
	var pods []corev1.Pod
	for i := 0; i < 40; i++ {
		pods = append(pods, nodePod("a", fmt.Sprintf("p-%02d", i), fmt.Sprintf("n%d", i%4)))
	}
	pods = append(pods, nodePod("a", "big-0", "big"), nodePod("a", "big-1", "big"), nodePod("a", "big-2", "big"))
	api := &clusterAPI{pods: pods, review: rbac(map[string][]string{"wide@example.com": {""}})}
	s, b := api.start(t, podObjects(pods)...)
	ctx := wideCaller("wide@example.com")
	one, err := s.GetPodsOnNodeJSON(ctx, "n0", "")
	if err != nil {
		t.Fatal(err)
	}
	keep := nodeBoxesKeepBytes
	t.Cleanup(func() { nodeBoxesKeepBytes = keep })
	nodeBoxesKeepBytes = 2*len(one) + len(one)/2 // two nodes' answers of ten pods, not three
	ci := b.inf
	kept := func() (n, bytes, sum int) {
		ci.boxes.mu.Lock()
		defer ci.boxes.mu.Unlock()
		for _, box := range ci.boxes.nodes {
			sum += len(box.raw)
		}
		return len(ci.boxes.nodes), ci.boxes.bytes, sum
	}
	for round := 0; round < 3; round++ {
		for _, node := range []string{"n0", "n1", "n2", "n3"} {
			raw, err := s.GetPodsOnNodeJSON(ctx, node, "")
			if err != nil || len(decodeBox(t, raw)) != 10 {
				t.Fatalf("%s: %s, %v", node, raw, err)
			}
			if n, bytes, sum := kept(); bytes != sum || bytes > nodeBoxesKeepBytes || n > 2 {
				t.Fatalf("after %s: %d answers kept, %d bytes counted, %d held, at most %d", node, n, bytes, sum, nodeBoxesKeepBytes)
			}
		}
	}
	nodeBoxesKeepBytes = 16 // smaller than any answer of a pod
	raw, err := s.GetPodsOnNodeJSON(ctx, "big", "")
	if err != nil || len(decodeBox(t, raw)) != 3 {
		t.Fatalf("big: %s, %v", raw, err)
	}
	ci.boxes.mu.Lock()
	_, keptBig := ci.boxes.nodes["big"]
	ci.boxes.mu.Unlock()
	if keptBig {
		t.Error("an answer past nodeBoxesKeepBytes was kept")
	}
}

// A synced store without the node index (AddIndexers refused) answers with the caller's own list, never from the store.
func TestANodeBoxWithoutTheNodeIndexIsTheCallersOwnList(t *testing.T) {
	pods := podsOnNodes()
	api := &clusterAPI{pods: pods, review: rbac(map[string][]string{"wide@example.com": {""}, "ac@example.com": {"a", "c"}})}
	s, b := api.start(t)
	idx := cache.NewIndexer(cache.DeletionHandlingMetaNamespaceKeyFunc, cache.Indexers{cache.NamespaceIndex: cache.MetaNamespaceIndexFunc})
	only := nodePod("a", "a-informer-only", "n1")
	_ = idx.Add(toPodRow(&only, newInterner()))
	ci := &clusterInformers{pods: idx, stop: make(chan struct{}), synced: make(chan struct{})}
	close(ci.synced)
	b.inf = ci
	for _, ctx := range []context.Context{wideCaller("wide@example.com"), grantCaller("ac@example.com", "a", "c")} {
		raw, err := s.GetPodsOnNodeJSON(ctx, "n1", "")
		if err != nil {
			t.Fatal(err)
		}
		want := ownBox(t, ctx, b, "n1", "")
		if len(want) == 0 || answerJSON(t, decodeBox(t, raw)) != answerJSON(t, want) {
			t.Errorf("no node index: got %s, the caller's own list %d pods", raw, len(want))
		}
	}
}

// A person with no grant scope who picks a namespace its RBAC refuses gets the refusal, after one list of that
// namespace's pods on the node as the person.
func TestANodeBoxOfANamespaceTheCallerMayNotListIsRefused(t *testing.T) {
	pods := podsOnNodes()
	api := &clusterAPI{pods: pods, review: rbac(map[string][]string{"inb@example.com": {"b"}})}
	s, _ := api.start(t, podObjects(pods)...)
	before := api.seen()
	raw, err := s.GetPodsOnNodeJSON(wideCaller("inb@example.com"), "n1", "a")
	if !apierrors.IsForbidden(err) {
		t.Errorf("namespace a for a reader of b: %s, %v", raw, err)
	}
	if got, want := api.listedSince(before), []string{"inb@example.com a spec.nodeName=n1"}; !slices.Equal(got, want) {
		t.Errorf("lists %v, want %v", got, want)
	}
}

// A pod not scheduled leaves the Unscheduled box for its node's once the scheduler gives it one.
func TestAPodScheduledMovesFromTheUnscheduledBoxToItsNodes(t *testing.T) {
	pods := podsOnNodes()
	api := &clusterAPI{pods: pods, review: rbac(map[string][]string{"wide@example.com": {""}})}
	s, b := api.start(t)
	ci, cs := servingInformers(t, pods)
	b.inf = ci
	box := func(node string) []string {
		raw, err := s.GetPodsOnNodeJSON(wideCaller("wide@example.com"), node, "")
		if err != nil {
			t.Fatal(err)
		}
		return boxNames(t, raw)
	}
	if got := box(""); !slices.Equal(got, []string{"b/b-pending Running ok"}) {
		t.Fatalf("not scheduled: %v", got)
	}
	if got := box("n2"); slices.ContainsFunc(got, func(s string) bool { return strings.HasPrefix(s, "b/b-pending ") }) {
		t.Fatalf("n2 before: %v", got)
	}
	p, err := cs.CoreV1().Pods("b").Get(context.Background(), "b-pending", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	p.Spec.NodeName, p.ResourceVersion = "n2", "9"
	if _, err := cs.CoreV1().Pods("b").Update(context.Background(), p, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if !eventually(t, 5*time.Second, func() bool {
		return len(box("")) == 0 && slices.ContainsFunc(box("n2"), func(s string) bool { return strings.HasPrefix(s, "b/b-pending ") })
	}) {
		t.Errorf("scheduled: Unscheduled %v, n2 %v", box(""), box("n2"))
	}
}

// Namespaces of which one starts another's name ("a", "a-b", "a.b", "a0", "ab") come in the API's order, the
// store key's (namespace/name), as the caller's own list gives them.
func TestANodeBoxOfPrefixNamespacesIsInTheAPIsOrder(t *testing.T) {
	var pods []corev1.Pod
	for _, ns := range []string{"a", "a-b", "a.b", "ab", "a0"} {
		pods = append(pods, nodePod(ns, "x", "n1"), nodePod(ns, "y", "n1"))
	}
	api := &clusterAPI{pods: pods, review: rbac(map[string][]string{"wide@example.com": {""}})}
	s, b := api.start(t, podObjects(pods)...)
	ctx := wideCaller("wide@example.com")
	raw, err := s.GetPodsOnNodeJSON(ctx, "n1", "")
	if err != nil {
		t.Fatal(err)
	}
	got, want := boxNames(t, raw), []string(nil)
	for _, p := range ownBox(t, ctx, b, "n1", "") {
		want = append(want, p.Namespace+"/"+p.Name+" "+p.Phase+" "+p.Health)
	}
	if !slices.Equal(got, want) || len(want) != 10 || want[0] != "a-b/x Running ok" {
		t.Errorf("order\n got %v\nwant %v", got, want)
	}
}

// A box served from the rows is in the call's trail as the Pods list's rows are: from Kubeast's cache.
func TestANodeBoxIsInTheTrailAsTheRowsOfTheCache(t *testing.T) {
	api := &clusterAPI{pods: podsOnNodes(), review: rbac(map[string][]string{"wide@example.com": {""}})}
	s, _ := api.start(t, podObjects(podsOnNodes())...)
	rec := &accesstrail.Recorder{}
	if _, err := s.GetPodsOnNodeJSON(accesstrail.NewContext(wideCaller("wide@example.com"), rec), "n1", ""); err != nil {
		t.Fatal(err)
	}
	var cached []string
	for _, r := range rec.Snapshot().Requests {
		if r.Source == "cache" {
			cached = append(cached, r.Cache)
		}
	}
	if want := []string{"pod rows (watched as " + overviewCacheUser + ")"}; !slices.Equal(cached, want) {
		t.Errorf("cached %v, want %v", cached, want)
	}
}

// Boxes asked while the informer takes changes read whole rows of their own node (go test -race).
func TestNodeBoxesWhileTheInformerTakesChanges(t *testing.T) {
	var pods []corev1.Pod
	for i := 0; i < 200; i++ {
		pods = append(pods, nodePod(fmt.Sprintf("ns-%d", i%4), fmt.Sprintf("p-%03d", i), fmt.Sprintf("n%d", i%5)))
	}
	api := &clusterAPI{pods: pods, review: rbac(map[string][]string{"wide@example.com": {""}, "two@example.com": {"ns-1", "ns-2"}})}
	s, b := api.start(t)
	ci, cs := servingInformers(t, pods)
	b.inf = ci
	// pods move from node to node while sixteen callers read boxes: at least 800 moves, and on until every caller has
	// read two boxes while they moved, so a slow machine lengthens the run instead of failing it
	var reads [16]atomic.Int64
	readTwice := func() bool {
		for r := range reads {
			if reads[r].Load() < 2 {
				return false
			}
		}
		return true
	}
	moving, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		ctx := context.Background()
		close(moving)
		for i := 0; i < 800 || !readTwice(); i++ {
			if i >= 200_000 {
				return // the callers never got to read: the check below says so
			}
			p := pods[i%len(pods)]
			got, err := cs.CoreV1().Pods(p.Namespace).Get(ctx, p.Name, metav1.GetOptions{})
			if err != nil {
				continue
			}
			got.Spec.NodeName = fmt.Sprintf("n%d", (i+1)%5)
			got.ResourceVersion = fmt.Sprint(100 + i)
			_, _ = cs.CoreV1().Pods(p.Namespace).Update(ctx, got, metav1.UpdateOptions{})
			// the fake cluster's watch holds 100 events and panics past them: an API server's pace, not a flood
			if i%5 == 4 {
				time.Sleep(time.Millisecond)
			}
		}
	}()
	var readers sync.WaitGroup
	<-moving
	for r := 0; r < 16; r++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			ctx := wideCaller("wide@example.com")
			if r%2 == 1 {
				ctx = grantCaller("two@example.com", "ns-1", "ns-2")
			}
			for i := 0; ; i++ {
				select {
				case <-done:
					return
				default:
				}
				node := fmt.Sprintf("n%d", (r+i)%5)
				raw, err := s.GetPodsOnNodeJSON(ctx, node, "")
				if err != nil {
					t.Error(err)
					return
				}
				for _, p := range decodeBox(t, raw) {
					if p.NodeName != node || p.Name == "" {
						t.Errorf("box of %s holds %+v", node, p)
						return
					}
				}
				reads[r].Add(1)
			}
		}()
	}
	readers.Wait()
	counts := make([]int64, len(reads))
	for r := range reads {
		counts[r] = reads[r].Load()
	}
	t.Logf("boxes read while the pods moved: %v", counts)
	if !readTwice() {
		t.Errorf("a caller read fewer than two boxes while the pods moved: %v", counts)
	}
	if n := podLists(api); n != 0 {
		t.Errorf("%d lists of pods", n)
	}
}

// rowInformers serves rows from a store with the informer's indexes, synced.
func rowInformers(rows []*podRow) *clusterInformers {
	idx := cache.NewIndexer(cache.DeletionHandlingMetaNamespaceKeyFunc, podRowIndexers())
	for _, r := range rows {
		_ = idx.Add(r)
	}
	ci := &clusterInformers{pods: idx, stop: make(chan struct{}), synced: make(chan struct{})}
	close(ci.synced)
	return ci
}

// BenchmarkNodeBox is one box's answer on 50 000 pods of 1 000 nodes, 50 a node in ten namespaces: a caller who may see
// every namespace opening a different node each time and the same node, and a grant of five namespaces.
func BenchmarkNodeBox(b *testing.B) {
	in := newInterner()
	rows := make([]*podRow, 0, 50_000)
	for i := 0; i < 50_000; i++ {
		p := listedPod(fmt.Sprintf("team-%02d", i%50/5), fmt.Sprintf("node-%04d", i/50), i)
		rows = append(rows, toPodRow(&p, in))
	}
	for _, c := range []struct {
		name string
		ctx  context.Context
		node func(i int) string
	}{
		{"wide-distinct-nodes", wideCaller("bench@example.com"), func(i int) string { return fmt.Sprintf("node-%04d", i%1000) }},
		{"wide-one-node", wideCaller("bench@example.com"), func(int) string { return "node-0001" }},
		{"grant-5-namespaces", grantCaller("five@example.com", "team-00", "team-01", "team-02", "team-03", "team-04"), func(i int) string { return fmt.Sprintf("node-%04d", i%1000) }},
	} {
		b.Run(c.name, func(b *testing.B) {
			ci := rowInformers(rows)
			s := &Service{}
			s.defaultBundle.Store(&clientBundle{id: "default", inf: ci})
			b.ReportAllocs()
			i := 0
			for b.Loop() {
				raw, err := s.GetPodsOnNodeJSON(c.ctx, c.node(i), "")
				if err != nil || len(raw) < 100 {
					b.Fatalf("%s %v", raw, err)
				}
				i++
			}
			b.ReportMetric(0, "lists/op")
		})
	}
}
