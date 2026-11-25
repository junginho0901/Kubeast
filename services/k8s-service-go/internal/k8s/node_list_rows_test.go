package k8s

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"reflect"
	"runtime"
	"sort"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/cache"
)

// steadyAge is an age that reads the same for 30 s at least: minutes and a quarter, hours and a half, days and a half.
func steadyAge(rng *rand.Rand) time.Duration {
	switch rng.Intn(3) {
	case 0:
		return time.Duration(1+rng.Intn(58))*time.Minute + 15*time.Second
	case 1:
		return time.Duration(1+rng.Intn(22))*time.Hour + 30*time.Minute
	default:
		return time.Duration(1+rng.Intn(400))*24*time.Hour + 12*time.Hour
	}
}

// listNode is a stored node (stripNode) like those of the KWOK cluster of the load runs, created that long ago: labels
// (some with what json.Marshal escapes), four resources, five conditions, an address, a taint or a cordon now and then.
func listNode(rng *rand.Rand, name string, created time.Duration) *corev1.Node {
	labels := map[string]string{
		"kubernetes.io/hostname":      name,
		"kubernetes.io/os":            "linux",
		"kubernetes.io/arch":          "amd64",
		"type":                        "kwok",
		"topology.kubernetes.io/zone": fmt.Sprintf("zone-%d", rng.Intn(3)),
	}
	if rng.Intn(10) == 0 {
		labels["node-role.kubernetes.io/control-plane"] = ""
	}
	if rng.Intn(4) == 0 {
		labels["team"] = "a<b>&c é\u2028"
	}
	ready := corev1.ConditionTrue
	if rng.Intn(15) == 0 {
		ready = corev1.ConditionFalse
	}
	n := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, UID: types.UID("uid-" + name), ResourceVersion: "1", Labels: labels,
			CreationTimestamp: metav1.NewTime(time.Now().Add(-created)),
		},
		Spec: corev1.NodeSpec{Unschedulable: rng.Intn(20) == 0},
		Status: corev1.NodeStatus{
			Capacity: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("32"), corev1.ResourceMemory: resource.MustParse("256Gi"),
				corev1.ResourcePods: resource.MustParse("110"), corev1.ResourceEphemeralStorage: resource.MustParse("100Gi"),
			},
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("31500m"), corev1.ResourceMemory: resource.MustParse("250Gi"),
				corev1.ResourcePods: resource.MustParse("110"), corev1.ResourceEphemeralStorage: resource.MustParse("95Gi"),
			},
			Conditions: []corev1.NodeCondition{
				{Type: corev1.NodeReady, Status: ready, Reason: "KubeletReady"},
				{Type: corev1.NodeMemoryPressure, Status: corev1.ConditionFalse, Reason: "KubeletHasSufficientMemory"},
				{Type: corev1.NodeDiskPressure, Status: corev1.ConditionFalse, Reason: "KubeletHasNoDiskPressure"},
				{Type: corev1.NodePIDPressure, Status: corev1.ConditionFalse, Reason: "KubeletHasSufficientPID"},
				{Type: corev1.NodeNetworkUnavailable, Status: corev1.ConditionFalse, Reason: "RouteCreated"},
			},
			Addresses: []corev1.NodeAddress{{Type: corev1.NodeInternalIP, Address: fmt.Sprintf("10.0.%d.%d", rng.Intn(256), rng.Intn(256))}},
			NodeInfo:  corev1.NodeSystemInfo{KubeletVersion: "v1.37.0", OSImage: "kwok", KernelVersion: "kwok", ContainerRuntimeVersion: "kwok"},
		},
	}
	if rng.Intn(10) == 0 {
		n.Spec.Taints = []corev1.Taint{{Key: "dedicated", Value: "gpu", Effect: corev1.TaintEffectNoSchedule}}
	}
	return stripNode(n)
}

// listInformers is an informer set whose node store holds the nodes and in which nothing runs: what nodeSummaries
// reads, with no watch changing the store or nodeRev under the test.
func listInformers(nodes ...*corev1.Node) *clusterInformers {
	store := cache.NewStore(cache.MetaNamespaceKeyFunc)
	for _, n := range nodes {
		_ = store.Add(n)
	}
	return &clusterInformers{nodes: store, stop: make(chan struct{}), synced: make(chan struct{})}
}

// encodedList is what json.Encoder writes for the items.
func encodedList(t testing.TB, items []map[string]interface{}) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := json.NewEncoder(&b).Encode(items); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// wholeNodeList is the node list as nodeSummaries made it before it kept rows: every stored node's row by name and
// the JSON of them all.
func wholeNodeList(ci *clusterInformers) ([]map[string]interface{}, []byte) {
	objs := ci.nodes.List()
	nodes := make([]*corev1.Node, 0, len(objs))
	for _, o := range objs {
		nodes = append(nodes, o.(*corev1.Node))
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
	items := make([]map[string]interface{}, 0, len(nodes))
	for _, n := range nodes {
		items = append(items, formatNodeSummary(n))
	}
	return items, (&nodeList{items: items}).JSON()
}

// mapID tells one map from another with the same contents.
func mapID(m map[string]interface{}) uintptr { return reflect.ValueOf(m).Pointer() }

// changeNode replaces a stored node with a copy that shows something else in the node list and counts the change, as
// the informers' handler does (sameNodeView).
func changeNode(t *testing.T, rng *rand.Rand, ci *clusterInformers, n *corev1.Node) *corev1.Node {
	t.Helper()
	c := n.DeepCopy()
	c.ResourceVersion += "x"
	switch rng.Intn(4) {
	case 0:
		c.Spec.Unschedulable = !c.Spec.Unschedulable
	case 1:
		c.Labels = map[string]string{"kubernetes.io/hostname": c.Name, "changed": c.ResourceVersion}
	case 2:
		if c.Status.Conditions[0].Status == corev1.ConditionTrue {
			c.Status.Conditions[0].Status = corev1.ConditionFalse
		} else {
			c.Status.Conditions[0].Status = corev1.ConditionTrue
		}
	default:
		c.Status.Allocatable = corev1.ResourceList{corev1.ResourceCPU: resource.MustParse(fmt.Sprintf("%dm", 1000+len(c.ResourceVersion)))}
	}
	if sameNodeView(n, c) {
		t.Fatalf("the change of %s shows nothing", n.Name)
	}
	if err := ci.nodes.Update(c); err != nil {
		t.Fatal(err)
	}
	ci.nodeRev.Add(1)
	return c
}

// heartbeatOf replaces a stored node with a copy that differs in its resourceVersion only, which nodeRev does not count.
func heartbeatOf(t *testing.T, ci *clusterInformers, n *corev1.Node) *corev1.Node {
	t.Helper()
	c := n.DeepCopy()
	c.ResourceVersion += "h"
	if err := ci.nodes.Update(c); err != nil {
		t.Fatal(err)
	}
	return c
}

// The node list made from the rows it keeps is, at every build, what the whole build made — the same rows by name and
// the bytes json.Encoder writes for them — over random nodes, none and one, through changes, heartbeats, nodes added
// and removed, in the same second and in the next.
func TestTheNodeListIsWhatTheWholeBuildMade(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for _, count := range []int{0, 1, 2, 37, 300} {
		nodes := make([]*corev1.Node, count)
		for i := range nodes {
			nodes[i] = listNode(rng, fmt.Sprintf("n-%04d", i), steadyAge(rng))
		}
		rng.Shuffle(len(nodes), func(i, j int) { nodes[i], nodes[j] = nodes[j], nodes[i] })
		ci := listInformers(nodes...)
		now := time.Now()
		check := func(step string, l *nodeList) {
			t.Helper()
			items, raw := wholeNodeList(ci)
			if !reflect.DeepEqual(l.items, items) {
				t.Fatalf("%d nodes, %s: the rows are not the whole build's:\n%v\nwhole:\n%v", count, step, l.items, items)
			}
			if !bytes.Equal(l.JSON(), raw) || !bytes.Equal(l.JSON(), encodedList(t, l.items)) {
				t.Fatalf("%d nodes, %s: the JSON is not the whole build's:\n%s\nwhole:\n%s", count, step, l.JSON(), raw)
			}
		}
		check("first", ci.nodeSummaries(now))
		next := count
		for step := 0; step < 40; step++ {
			objs := ci.nodes.List()
			switch k := rng.Intn(6); {
			case k == 0 && len(objs) > 0:
				changeNode(t, rng, ci, objs[rng.Intn(len(objs))].(*corev1.Node))
			case k == 1 && len(objs) > 0:
				heartbeatOf(t, ci, objs[rng.Intn(len(objs))].(*corev1.Node))
			case k == 2:
				if err := ci.nodes.Add(listNode(rng, fmt.Sprintf("n-%04d", next), steadyAge(rng))); err != nil {
					t.Fatal(err)
				}
				next++
				ci.nodeRev.Add(1)
			case k == 3 && len(objs) > 0:
				if err := ci.nodes.Delete(objs[rng.Intn(len(objs))]); err != nil {
					t.Fatal(err)
				}
				ci.nodeRev.Add(1)
			}
			if rng.Intn(2) == 0 {
				now = now.Add(time.Second)
			}
			check(fmt.Sprintf("step %d", step), ci.nodeSummaries(now))
		}
	}
}

// A new second whose rows all read as before keeps the list and its JSON, also when heartbeats replaced the stored
// nodes; the rows then hold the stored nodes, not those the heartbeats replaced.
func TestANewSecondKeepsTheListWhenNoRowReadsDifferently(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	nodes := make([]*corev1.Node, 50)
	for i := range nodes {
		nodes[i] = listNode(rng, fmt.Sprintf("n-%02d", i), steadyAge(rng))
	}
	ci := listInformers(nodes...)
	now := time.Now()
	first := ci.nodeSummaries(now)
	for i := 0; i < 50; i += 5 {
		heartbeatOf(t, ci, nodes[i])
	}
	for s := 1; s <= 3; s++ {
		again := ci.nodeSummaries(now.Add(time.Duration(s) * time.Second))
		if again != first || &again.JSON()[0] != &first.JSON()[0] {
			t.Fatalf("second %d: the list or its JSON was made again with no row reading differently", s)
		}
	}
	for _, r := range ci.nodeListRows {
		stored, _, _ := ci.nodes.GetByKey(r.node.Name)
		if r.node != stored.(*corev1.Node) {
			t.Fatalf("the row of %s holds a node the store replaced", r.node.Name)
		}
	}
	if items, raw := wholeNodeList(ci); !reflect.DeepEqual(first.items, items) || !bytes.Equal(first.JSON(), raw) {
		t.Fatal("the list kept is not the whole build's")
	}
}

// A new second makes again only the rows whose age reads differently and keeps the others' rows, their maps and the
// list kept before as it was.
func TestANewSecondMakesAgainOnlyTheRowsWhoseAgeMoved(t *testing.T) {
	t.Run("an age the row no longer reads", func(t *testing.T) {
		rng := rand.New(rand.NewSource(3))
		ci := listInformers(listNode(rng, "a", 3*24*time.Hour), listNode(rng, "b", 5*24*time.Hour), listNode(rng, "c", 7*24*time.Hour))
		now := time.Now()
		first := ci.nodeSummaries(now)
		firstRaw := append([]byte(nil), first.JSON()...)
		madeEarlier(ci, 1)
		l := ci.nodeSummaries(now.Add(time.Second))
		if l == first {
			t.Fatal("a row whose age moved left the list as it was")
		}
		if mapID(l.items[0]) != mapID(first.items[0]) || mapID(l.items[2]) != mapID(first.items[2]) {
			t.Fatal("rows whose age did not move were made again")
		}
		if mapID(l.items[1]) == mapID(first.items[1]) || l.items[1]["age"] != "5d" {
			t.Fatalf("b's row was not made again: %v", l.items[1])
		}
		if items, raw := wholeNodeList(ci); !reflect.DeepEqual(l.items, items) || !bytes.Equal(l.JSON(), raw) {
			t.Fatal("the list is not the whole build's")
		}
		if !bytes.Equal(first.JSON(), firstRaw) {
			t.Fatal("the list before changed while the next was made")
		}
	})
	t.Run("a node seconds old on the clock", func(t *testing.T) {
		rng := rand.New(rand.NewSource(4))
		ci := listInformers(listNode(rng, "a", 3*24*time.Hour), listNode(rng, "b", 0), listNode(rng, "c", 7*24*time.Hour))
		first := ci.nodeSummaries(time.Now())
		var l *nodeList
		if !eventually(t, 3*time.Second, func() bool {
			l = ci.nodeSummaries(time.Now())
			return l != first
		}) {
			t.Fatal("the list of a node created a moment ago stayed as it was for three seconds")
		}
		if mapID(l.items[0]) != mapID(first.items[0]) || mapID(l.items[2]) != mapID(first.items[2]) {
			t.Fatal("rows days old were made again")
		}
		if l.items[1]["age"] == first.items[1]["age"] {
			t.Fatalf("a new list with b's age as it was: %v", l.items[1]["age"])
		}
		if !bytes.Equal(l.JSON(), encodedList(t, l.items)) {
			t.Fatalf("the JSON is not the encoder's:\n%s", l.JSON())
		}
	})
}

// A node that changes what it shows is in the list in the same second, its row alone made again; a node added or
// removed keeps the other rows.
func TestAChangeShowsInTheSameSecondAndKeepsTheOtherRows(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	b := listNode(rng, "b", 2*24*time.Hour)
	b.Spec.Unschedulable = false
	ci := listInformers(listNode(rng, "a", 2*24*time.Hour), b, listNode(rng, "d", 2*24*time.Hour))
	now := time.Now()
	first := ci.nodeSummaries(now)

	cordoned := b.DeepCopy()
	cordoned.ResourceVersion = "2"
	cordoned.Spec.Unschedulable = true
	if err := ci.nodes.Update(cordoned); err != nil {
		t.Fatal(err)
	}
	ci.nodeRev.Add(1)
	l := ci.nodeSummaries(now)
	if l == first || l.items[1]["unschedulable"] != true {
		t.Fatalf("the cordon did not show in the same second: %v", l.items[1])
	}
	if mapID(l.items[0]) != mapID(first.items[0]) || mapID(l.items[2]) != mapID(first.items[2]) {
		t.Fatal("the rows of nodes that did not change were made again")
	}

	if err := ci.nodes.Add(listNode(rng, "c", 2*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := ci.nodes.Delete(ci.nodeListRows[0].node); err != nil {
		t.Fatal(err)
	}
	ci.nodeRev.Add(1)
	m := ci.nodeSummaries(now)
	if got := nodeNames(m.items); !reflect.DeepEqual(got, []string{"b", "c", "d"}) {
		t.Fatalf("order %v", got)
	}
	if mapID(m.items[0]) != mapID(l.items[1]) || mapID(m.items[2]) != mapID(l.items[2]) {
		t.Fatal("the rows of nodes still there were made again")
	}
	if items, raw := wholeNodeList(ci); !reflect.DeepEqual(m.items, items) || !bytes.Equal(m.JSON(), raw) {
		t.Fatal("the list is not the whole build's")
	}
}

// A list handed out stays as it was while the lists after it are made, read from many requests at once (run with
// -race): each list is the encoder's bytes for its rows, and the first list keeps its rows and bytes to the end.
func TestAListHandedOutStaysAsItWasWhileTheNextAreMade(t *testing.T) {
	rng := rand.New(rand.NewSource(6))
	nodes := make([]*corev1.Node, 60)
	for i := range nodes {
		nodes[i] = listNode(rng, fmt.Sprintf("n-%02d", i), steadyAge(rng))
	}
	ci := listInformers(nodes...)
	start := time.Now()
	first := ci.nodeSummaries(start)
	wantItems, wantRaw := wholeNodeList(ci)

	var wg sync.WaitGroup
	failed := make(chan string, 8)
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				l := ci.nodeSummaries(start.Add(time.Duration(i/10) * time.Second))
				var b bytes.Buffer
				if err := json.NewEncoder(&b).Encode(l.items); err != nil || !bytes.Equal(l.JSON(), b.Bytes()) {
					failed <- fmt.Sprintf("reader %d call %d: the JSON is not the encoder's", g, i)
					return
				}
			}
		}(g)
	}
	for i := 0; i < 100; i++ {
		objs := ci.nodes.List()
		n := objs[rng.Intn(len(objs))].(*corev1.Node)
		if i%2 == 0 {
			changeNode(t, rng, ci, n)
		} else {
			heartbeatOf(t, ci, n)
		}
	}
	wg.Wait()
	close(failed)
	for f := range failed {
		t.Error(f)
	}
	if !reflect.DeepEqual(first.items, wantItems) || !bytes.Equal(first.JSON(), wantRaw) {
		t.Fatal("the first list changed while the next were made")
	}
}

// The age is the one field of a node list row that moves with the clock: nodeListRowsOf keeps a row whose node is the
// same and whose age reads the same, so a new field that reads the clock must be compared there too. The fields are
// listed here so that a new one comes past this test.
func TestTheNodeRowMovesWithTheClockOnlyInItsAge(t *testing.T) {
	n := stripNode(fullNode("n1"))
	n.CreationTimestamp = metav1.NewTime(time.Now().Add(-500 * time.Millisecond))
	before := formatNodeSummary(n)
	keys := make([]string, 0, len(before))
	for k := range before {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := []string{"age", "allocatable", "capacity", "conditions", "container_runtime", "created_at", "external_ip", "internal_ip",
		"kernel_version", "kubelet_version", "labels", "name", "os_image", "roles", "status", "taints", "unschedulable", "version"}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("the node list row has the fields\n%v\nwhere this test lists\n%v\na field that reads the clock goes into nodeListRowsOf's comparison beside the age; then list the fields here", keys, want)
	}
	time.Sleep(1100 * time.Millisecond)
	after := formatNodeSummary(n)
	if before["age"] == after["age"] {
		t.Fatalf("the age read %v before and after a second", after["age"])
	}
	delete(before, "age")
	delete(after, "age")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("a field other than the age moved with the clock:\n%v\n%v", before, after)
	}
}

// allocatedBy is the least the call allocated in three runs; prepare runs before each, outside the count.
func allocatedBy(prepare, call func()) uint64 {
	least := ^uint64(0)
	for i := 0; i < 3; i++ {
		prepare()
		var m0, m1 runtime.MemStats
		runtime.ReadMemStats(&m0)
		call()
		runtime.ReadMemStats(&m1)
		if d := m1.TotalAlloc - m0.TotalAlloc; d < least {
			least = d
		}
	}
	return least
}

// nodeListOf1001 is the informer set of the load runs' 1 001 nodes and its first list.
func nodeListOf1001() (*clusterInformers, time.Time) {
	rng := rand.New(rand.NewSource(7))
	nodes := make([]*corev1.Node, 1001)
	for i := range nodes {
		nodes[i] = listNode(rng, fmt.Sprintf("kwok-node-%04d", i), steadyAge(rng))
	}
	ci := listInformers(nodes...)
	now := time.Now()
	ci.nodeSummaries(now)
	return ci, now
}

// madeEarlier puts in row i what it read when its node was 30 s old: a row made with an age it no longer reads. The
// row keeps the stored node, as a row whose age moved does.
func madeEarlier(ci *clusterInformers, i int) {
	r := &ci.nodeListRows[i]
	younger := r.node.DeepCopy()
	younger.CreationTimestamp = metav1.NewTime(time.Now().Add(-30 * time.Second))
	was := nodeListRowOf(younger)
	r.age, r.item, r.raw = was.age, was.item, was.raw
}

// moveAges makes k rows from the from-th on rows made with an age they no longer read, as when the minute turns over
// for k nodes.
func moveAges(ci *clusterInformers, from, k int) {
	for i := 0; i < k; i++ {
		madeEarlier(ci, (from+i)%len(ci.nodeListRows))
	}
}

// Each new second, a list of 1 001 nodes allocates a small part of what making every row and its JSON did: next to
// nothing while no row reads differently, about the one copy of the bytes when 17 ages moved (1 001 nodes created over
// a minute turn over 17 a second).
func TestANewSecondAllocatesAFractionOfTheWholeBuild(t *testing.T) {
	ci, now := nodeListOf1001()
	whole := allocatedBy(func() {}, func() { _, _ = wholeNodeList(ci) })
	s := 0
	kept := allocatedBy(func() { s++ }, func() { ci.nodeSummaries(now.Add(time.Duration(s) * time.Second)) })
	moved := allocatedBy(func() { s++; moveAges(ci, 17*s, 17) }, func() { ci.nodeSummaries(now.Add(time.Duration(s) * time.Second)) })
	t.Logf("a new second of 1 001 nodes: whole build %.2f MiB, no row moved %.3f MiB, 17 ages moved %.2f MiB",
		float64(whole)/(1<<20), float64(kept)/(1<<20), float64(moved)/(1<<20))
	if kept > whole/20 {
		t.Fatalf("a second with no row moved allocated %d bytes, the whole build %d", kept, whole)
	}
	if moved > whole/3 {
		t.Fatalf("a second with 17 ages moved allocated %d bytes, the whole build %d", moved, whole)
	}
}

// BenchmarkNodeListASecondLater is a new second of a list of 1 001 nodes: the whole build as before, no row moved, and
// 17 ages moved.
func BenchmarkNodeListASecondLater(b *testing.B) {
	b.Run("whole build", func(b *testing.B) {
		ci, _ := nodeListOf1001()
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_, _ = wholeNodeList(ci)
		}
	})
	b.Run("no row moved", func(b *testing.B) {
		ci, now := nodeListOf1001()
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			ci.nodeSummaries(now.Add(time.Duration(i+1) * time.Second))
		}
	})
	b.Run("17 ages moved", func(b *testing.B) {
		ci, now := nodeListOf1001()
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			b.StopTimer()
			moveAges(ci, 17*i, 17)
			b.StartTimer()
			ci.nodeSummaries(now.Add(time.Duration(i+1) * time.Second))
		}
	})
}
