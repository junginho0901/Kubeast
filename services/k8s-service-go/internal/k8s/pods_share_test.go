package k8s

import (
	"context"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/flight"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// shareNow is the clock of the shared pods answers' tests: some pods are made after it.
var shareNow = time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)

// shareCluster serves pods from synced informers, each caller's reviews answered by rbac(grants), the clock at shareNow.
func shareCluster(t *testing.T, pods []k8sruntime.Object, grants map[string][]string) (*Service, *clusterInformers) {
	t.Helper()
	api := &clusterAPI{review: rbac(grants)}
	s, b := api.start(t, pods...)
	s.podClock = func() time.Time { return shareNow }
	return s, b.inf
}

// podScreen is one of the two answers shared by podShareKey as a test asks it: the page reads every field of the query,
// the node map its Namespace, Search (its q) and Revision.
type podScreen struct {
	name    string
	ask     func(s *Service, ctx context.Context, q PodPageQuery) string
	own     func(s *Service, ctx context.Context, q PodPageQuery) string
	key     func(set *podRowSet, q PodPageQuery) podShareKey
	answers func(ci *clusterInformers) *flight.Group[*podAnswer]
}

var podScreens = []podScreen{
	{
		name:    "pods-page",
		ask:     func(s *Service, ctx context.Context, q PodPageQuery) string { return said(s.GetPodPageJSON(ctx, q)) },
		own:     ownPodPage,
		key:     podPageShareKey,
		answers: func(ci *clusterInformers) *flight.Group[*podAnswer] { return &ci.answers.page },
	},
	{
		name: "pods-nodes",
		ask: func(s *Service, ctx context.Context, q PodPageQuery) string {
			return said(s.GetPodNodeSummaryJSON(ctx, q.Namespace, q.Search, q.Revision))
		},
		own:     ownNodeMap,
		key:     func(set *podRowSet, q PodPageQuery) podShareKey { return podNodesShareKey(set, q.Namespace, q.Search) },
		answers: func(ci *clusterInformers) *flight.Group[*podAnswer] { return &ci.answers.nodes },
	},
}

func said(raw []byte, err error) string {
	if err != nil {
		return "error: " + err.Error()
	}
	return string(raw)
}

// written is the body response.JSON writes of v.
func written(v any) string {
	rec := httptest.NewRecorder()
	response.JSON(rec, http.StatusOK, v)
	return rec.Body.String()
}

// decided is a caller's access decision and revision as GetPodPage made them before its answer was shared.
func decided(s *Service, ctx context.Context, namespace string) (ci *clusterInformers, all bool, namespaces []string, rev string, err error) {
	b := s.bundleForCtx(ctx)
	ci = b.syncedInformers()
	all, namespaces, err = s.podListAccess(ctx, b, namespace)
	if err != nil {
		return nil, false, nil, "", err
	}
	return ci, all, namespaces, ci.podRevision() + "." + accessPrint(all, namespaces), nil
}

// ownPodPage is what GET /api/v1/pods/page wrote for the caller before the answers were shared: a copy of GetPodPage
// and its handler as they were, the clock at shareNow.
func ownPodPage(s *Service, ctx context.Context, q PodPageQuery) string {
	ci, all, namespaces, rev, err := decided(s, ctx, q.Namespace)
	if err != nil {
		return "error: " + err.Error()
	}
	if q.Revision == rev {
		return written(&PodPage{Filters: q.filters(), Items: []PodListItem{}, Stats: PodStats{TopReasons: []PodReasonCount{}}, Revision: rev, Unchanged: true, Source: "index"})
	}
	page := buildPodPage(rowsOfOwner(ci.podRows(all, namespaces), q.OwnerKind, q.OwnerName), q, shareNow)
	page.Filters, page.Revision, page.Source = q.filters(), rev, "index"
	return written(page)
}

// ownNodeMap is what GET /api/v1/pods/nodes wrote for the caller before the answers were shared.
func ownNodeMap(s *Service, ctx context.Context, q PodPageQuery) string {
	ci, all, namespaces, rev, err := decided(s, ctx, q.Namespace)
	if err != nil {
		return "error: " + err.Error()
	}
	if q.Revision == rev {
		return written(&PodNodeSummary{Nodes: []PodNodeCount{}, Revision: rev, Unchanged: true, Source: "index"})
	}
	sum := podNodeSummary(ci.podRows(all, namespaces), q.Search)
	sum.Revision, sum.Source = rev, "index"
	return written(sum)
}

// keyOf is the key ctx's answer to q is built under, "" when it is refused or its revision is current.
func keyOf(t *testing.T, s *Service, sc podScreen, ctx context.Context, q PodPageQuery) string {
	t.Helper()
	_, all, namespaces, rev, err := decided(s, ctx, q.Namespace)
	if err != nil || q.Revision == rev {
		return ""
	}
	key, ok := sc.key(&podRowSet{revision: rev, all: all, namespaces: namespaces}, q).text()
	if !ok {
		t.Fatalf("%+v: a key that is not shared", q)
	}
	return key
}

// buildGate watches the shared answers' builds (Service.podBuildStep): it counts each step by key ("no place" too, a build
// that stopped waiting for a place) and holds the builds hold picks at step until open.
type buildGate struct {
	step   string                       // "place" (before the build waits for a place) or "rows" (holding a place and the rows)
	hold   func(nth, nthOfKey int) bool // counted at step
	panics func(nth int) bool           // counted at "rows"

	mu      sync.Mutex
	counts  map[string]map[string]int // by step, by key
	totals  map[string]int
	holding int
	opened  chan struct{}
	once    sync.Once
}

func watchBuilds(t *testing.T, s *Service, g *buildGate) *buildGate {
	g.counts, g.totals, g.opened = map[string]map[string]int{}, map[string]int{}, make(chan struct{})
	s.podBuildStep = g.at
	t.Cleanup(g.open)
	return g
}

func (g *buildGate) at(key, step string) {
	g.mu.Lock()
	if g.counts[step] == nil {
		g.counts[step] = map[string]int{}
	}
	g.totals[step]++
	g.counts[step][key]++
	nth, ofKey := g.totals[step], g.counts[step][key]
	wait := step == g.step && g.hold != nil && g.hold(nth, ofKey)
	if wait {
		g.holding++
	}
	g.mu.Unlock()
	if wait {
		<-g.opened
		g.mu.Lock()
		g.holding--
		g.mu.Unlock()
	}
	if step == "rows" && g.panics != nil && g.panics(nth) {
		panic("a build that fails")
	}
}

func (g *buildGate) open() { g.once.Do(func() { close(g.opened) }) }

func (g *buildGate) held() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.holding
}

// builds is how many builds of key read the rows.
func (g *buildGate) builds(key string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.counts["rows"][key]
}

// steps is how many builds came to step.
func (g *buildGate) steps(step string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.totals[step]
}

// asking is one caller's question under way.
type asking struct {
	got  string
	done chan struct{}
}

func askNow(f func() string) *asking {
	a := &asking{done: make(chan struct{})}
	go func() {
		defer close(a.done)
		a.got = f()
	}()
	return a
}

func (a *asking) finished() bool {
	select {
	case <-a.done:
		return true
	default:
		return false
	}
}

func (a *asking) wait(t *testing.T) string {
	t.Helper()
	select {
	case <-a.done:
		return a.got
	case <-time.After(10 * time.Second):
		t.Fatal("no answer in 10 s")
		return ""
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	if !eventually(t, 10*time.Second, cond) {
		t.Fatalf("not in 10 s: %s", what)
	}
}

// shareAsk is one caller's question.
type shareAsk struct {
	ctx context.Context
	q   PodPageQuery
}

// crowdOf asks every one of asks at once, holding the first build of each key before its place until everyone else with
// that key waits for the next build (then whileHeld runs), and returns what each got and the key each was asked under.
func crowdOf(t *testing.T, s *Service, ci *clusterInformers, sc podScreen, asks []shareAsk, whileHeld func()) ([]string, []string, *buildGate) {
	t.Helper()
	keys := make([]string, len(asks))
	want := map[string]int{}
	for i, a := range asks {
		if keys[i] = keyOf(t, s, sc, a.ctx, a.q); keys[i] != "" {
			want[keys[i]]++
		}
	}
	g := watchBuilds(t, s, &buildGate{step: "place", hold: func(_, nthOfKey int) bool { return nthOfKey == 1 }})
	going := make([]*asking, len(asks))
	for i, a := range asks {
		going[i] = askNow(func() string { return sc.ask(s, a.ctx, a.q) })
	}
	waitFor(t, "everyone but the first of each key waits for the next build", func() bool {
		for key, n := range want {
			if sc.answers(ci).Waiting(key) != n-1 {
				return false
			}
		}
		return true
	})
	if whileHeld != nil {
		whileHeld()
	}
	g.open()
	got := make([]string, len(asks))
	for i, a := range going {
		got[i] = a.wait(t)
	}
	return got, keys, g
}

// shareNamespaces are the pods' namespaces; "team" is a prefix of two others, which the API's order reads apart.
var shareNamespaces = []string{"team", "team-a", "team-b", "shop", "bulk", "kube-system"}

// sharePods are n pods drawn over what the page filters and sorts by: labels, owners, nodes (none too), service accounts,
// RuntimeClass, PriorityClass, ConfigMap and Secret volumes, made at no time, before shareNow or after it.
func sharePods(rng *rand.Rand, n int) []k8sruntime.Object {
	out := make([]k8sruntime.Object, 0, n)
	for i := 0; i < n; i++ {
		p := randomPod(rng, i)
		p.Namespace = shareNamespaces[rng.Intn(len(shareNamespaces))]
		p.Labels = map[string]string{"app": fmt.Sprintf("app-%02d", rng.Intn(12))}
		if rng.Intn(3) == 0 {
			p.Labels["tier"] = []string{"web", "db"}[rng.Intn(2)]
		}
		if rng.Intn(4) == 0 {
			p.Labels["release"] = "r" + strconv.Itoa(rng.Intn(3))
		}
		if rng.Intn(10) == 0 {
			p.OwnerReferences = nil
		}
		switch rng.Intn(10) {
		case 0:
			p.CreationTimestamp = metav1.Time{}
		case 1:
			p.CreationTimestamp = metav1.NewTime(shareNow.Add(time.Duration(1+rng.Intn(3600)) * time.Second))
		default:
			p.CreationTimestamp = metav1.NewTime(shareNow.Add(-time.Duration(rng.Intn(30*24*60)) * time.Minute))
		}
		if rng.Intn(10) == 0 {
			p.Spec.NodeName = ""
		}
		p.Spec.ServiceAccountName = []string{"default", "app", "worker"}[rng.Intn(3)]
		if rc := []string{"", "", "gvisor", "kata"}[rng.Intn(4)]; rc != "" {
			p.Spec.RuntimeClassName = &rc
		}
		p.Spec.PriorityClassName = []string{"", "", "high", "low"}[rng.Intn(4)]
		if rng.Intn(3) == 0 {
			p.Spec.Volumes = append(p.Spec.Volumes, corev1.Volume{Name: "config", VolumeSource: corev1.VolumeSource{
				ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: fmt.Sprintf("cm-%d", rng.Intn(3))}}}})
		}
		if rng.Intn(3) == 0 {
			p.Spec.Volumes = append(p.Spec.Volumes, corev1.Volume{Name: "secret", VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{SecretName: fmt.Sprintf("sec-%d", rng.Intn(3))}}})
		}
		out = append(out, p)
	}
	return out
}

// sharePeople are n people of three kinds, drawn so that several come to one decision: who may list pods everywhere,
// who may list them in some namespaces only, and grants limited to namespaces in one order or another, the cluster
// refusing the last of them for some.
func sharePeople(rng *rand.Rand, n int) ([]context.Context, map[string][]string) {
	some := [][]string{{"shop"}, {"shop", "bulk"}, {"team"}}
	orders := [][]string{{"team", "shop"}, {"shop", "team"}, {"team", "shop", "bulk"}, {"team-a"}, {"bulk", "kube-system", "team-b"}}
	grants := map[string][]string{}
	people := make([]context.Context, n)
	for i := range people {
		user := fmt.Sprintf("u%02d@example.com", i)
		switch rng.Intn(3) {
		case 0:
			people[i], grants[user] = wideCaller(user), []string{""}
		case 1:
			people[i], grants[user] = wideCaller(user), some[rng.Intn(len(some))]
		default:
			grant := orders[rng.Intn(len(orders))]
			allowed := grant
			if rng.Intn(3) == 0 {
				allowed = grant[:len(grant)-1]
			}
			people[i], grants[user] = grantCaller(user, grant...), slices.Clone(allowed)
		}
	}
	return people, grants
}

// randomPodQuery is a page query over every field the handler fills, values drawn from what the pods have and what none has.
func randomPodQuery(rng *rand.Rand) PodPageQuery {
	pick := func(values ...string) string { return values[rng.Intn(len(values))] }
	q := PodPageQuery{
		Namespace:     pick("", "", "team", "shop", "team-a", "nowhere"),
		Search:        pick("", "", "app-0", "APP-01", "10.0.1", "node-01", "team", "app 03", "zz"),
		Sort:          pick(append([]string{""}, PodSortKeys...)...),
		Desc:          rng.Intn(2) == 0,
		Offset:        []int{0, 0, 1, 7, 49, 400, 100_000}[rng.Intn(7)],
		Limit:         []int{1, 10, 50, 50, PodPageMaxLimit}[rng.Intn(5)],
		Health:        pick("", "", "ok", "warn", "error"),
		Phase:         pick("", "", "", "Running", "Pending", "Unknown", "Failed"),
		RuntimeClass:  pick("", "", "", "gvisor"),
		PriorityClass: pick("", "", "", "high"),
		Tokens:        rng.Intn(4) == 0,
		Groups:        rng.Intn(3) == 0,
		GroupTop:      []int{0, 0, 1, 3, PodGroupTopMax}[rng.Intn(5)],
	}
	if rng.Intn(5) == 0 {
		q.OwnerKind, q.OwnerName = "ReplicaSet", fmt.Sprintf("app-%03d-7d9f8c6b5", rng.Intn(40))
	}
	if rng.Intn(5) == 0 {
		q.ServiceAccounts = []string{pick("team", "shop") + "/" + pick("app", "worker")}
		if rng.Intn(2) == 0 {
			q.ServiceAccounts = append(q.ServiceAccounts, "shop/default")
		}
	}
	if q.Namespace != "" && rng.Intn(4) == 0 {
		q.ConfigMap = fmt.Sprintf("cm-%d", rng.Intn(3))
	}
	if q.Namespace != "" && rng.Intn(4) == 0 {
		q.Secret = fmt.Sprintf("sec-%d", rng.Intn(3))
	}
	if rng.Intn(4) == 0 {
		// one selector in other words is another answer: the page gives its text back
		text := pick("app=app-03", "app==app-03", "app in (app-03,app-07)", "tier!=web", "!release", "tier")
		sel, err := labels.Parse(text)
		if err != nil {
			panic(err)
		}
		q.LabelSelector, q.LabelSelectorText = sel, text
	}
	return q
}

// Forty people of every kind of access, asking at once for one of three random queries, a few with a revision from before
// and a few with the current one, get each the bytes GET /api/v1/pods/page (and /pods/nodes) wrote for them before the
// answers were shared, while the first build of each key is held until all who share it wait; one key's callers get one
// set of bytes from at most two builds. POD_SHARE_SEED gives a seed again, POD_SHARE_ROUNDS more rounds.
func TestASharedPodPageIsEachCallersOwnAnswer(t *testing.T) {
	seed := time.Now().UnixNano()
	if v, err := strconv.ParseInt(os.Getenv("POD_SHARE_SEED"), 10, 64); err == nil {
		seed = v
	}
	rounds := 4
	if v, err := strconv.Atoi(os.Getenv("POD_SHARE_ROUNDS")); err == nil && v > 0 {
		rounds = v
	}
	t.Logf("POD_SHARE_SEED=%d POD_SHARE_ROUNDS=%d", seed, rounds)
	rng := rand.New(rand.NewSource(seed))
	pods := sharePods(rng, 2000+rng.Intn(3001))
	people, grants := sharePeople(rng, 40)
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pods, grants)
			for round := 0; round < rounds; round++ {
				queries := []PodPageQuery{randomPodQuery(rng), randomPodQuery(rng), randomPodQuery(rng)}
				asks := make([]shareAsk, len(people))
				for i, ctx := range people {
					q := queries[rng.Intn(len(queries))]
					switch rng.Intn(10) {
					case 0, 1:
						q.Revision = "stale-" + randSuffix(rng)
					case 2:
						if _, _, _, rev, err := decided(s, ctx, q.Namespace); err == nil {
							q.Revision = rev
						}
					}
					asks[i] = shareAsk{ctx, q}
				}
				got, keys, g := crowdOf(t, s, ci, sc, asks, nil)
				byKey := map[string]string{}
				for i, a := range asks {
					if want := sc.own(s, a.ctx, a.q); got[i] != want {
						t.Fatalf("seed %d, round %d, caller %d asking %+v:\n got %.400s\nwant %.400s", seed, round, i, a.q, got[i], want)
					}
					if keys[i] == "" {
						continue
					}
					if first, ok := byKey[keys[i]]; ok && first != got[i] {
						t.Fatalf("seed %d, round %d: one key, two answers:\n%.300s\n%.300s", seed, round, first, got[i])
					}
					byKey[keys[i]] = got[i]
					if n := g.builds(keys[i]); n > 2 {
						t.Fatalf("seed %d, round %d: %d builds of one key at one moment, want at most 2", seed, round, n)
					}
				}
				if n := len(podRowSlots); n != 0 {
					t.Fatalf("seed %d, round %d: %d places still held", seed, round, n)
				}
			}
		})
	}
}

// accessPrintCollision finds two namespaces whose lists of one have one accessPrint (FNV-32a): a key holding the print in
// place of the list would give the pods of one to the other.
func accessPrintCollision(t *testing.T) (string, string) {
	t.Helper()
	seen := map[string]string{}
	for i := 0; i < 1<<22; i++ {
		ns := "ns-" + strconv.Itoa(i)
		sum := accessPrint(false, []string{ns})
		if other, ok := seen[sum]; ok {
			return other, ns
		}
		seen[sum] = ns
	}
	t.Fatal("no two namespaces of one accessPrint")
	return "", ""
}

// Two people whose access decisions differ never share a build, even when the first build of one is under way as the
// other comes and a third with the first one's decision comes after: every namespace against each of them named, [a]
// against [a, b], [a, b] against [b, a], two lists of one accessPrint, and one grant the cluster refuses another
// namespace of for each.
func TestPeopleWhoMaySeeDifferentPodsNeverShareAnAnswer(t *testing.T) {
	x, y := accessPrintCollision(t)
	if accessPrint(false, []string{x}) != accessPrint(false, []string{y}) {
		t.Fatalf("%s and %s do not share an accessPrint", x, y)
	}
	namespaces := []string{"a", "b", "c", x, y}
	var pods []k8sruntime.Object
	for i, ns := range namespaces {
		for j := 0; j <= i; j++ {
			pods = append(pods, overviewPod(ns, fmt.Sprintf("%s-p%d", ns, j), corev1.PodRunning))
		}
	}
	type person func(user string) (context.Context, []string)
	everywhere := func(user string) (context.Context, []string) { return wideCaller(user), []string{""} }
	granted := func(grant []string, refused ...string) person {
		return func(user string) (context.Context, []string) {
			allowed := slices.DeleteFunc(slices.Clone(grant), func(ns string) bool { return slices.Contains(refused, ns) })
			return grantCaller(user, grant...), allowed
		}
	}
	pairs := []struct {
		name string
		p, q person
	}{
		{"every namespace against each named", everywhere, granted(namespaces)},
		{"a against a b", granted([]string{"a"}), granted([]string{"a", "b"})},
		{"a b against b a", granted([]string{"a", "b"}), granted([]string{"b", "a"})},
		{"two lists of one accessPrint", granted([]string{x}), granted([]string{y})},
		{"one grant each refused another", granted([]string{"a", "b", "c"}, "c"), granted([]string{"a", "b", "c"}, "b")},
	}
	query := PodPageQuery{Limit: 50}
	for _, sc := range podScreens {
		for _, pair := range pairs {
			t.Run(sc.name+"/"+pair.name, func(t *testing.T) {
				grants := map[string][]string{}
				var p1, q1, p2 context.Context
				p1, grants["p1@example.com"] = pair.p("p1@example.com")
				q1, grants["q1@example.com"] = pair.q("q1@example.com")
				p2, grants["p2@example.com"] = pair.p("p2@example.com")
				s, ci := shareCluster(t, pods, grants)
				pKey, qKey := keyOf(t, s, sc, p1, query), keyOf(t, s, sc, q1, query)
				if pKey == "" || qKey == "" || pKey == qKey {
					t.Fatalf("keys %q and %q", pKey, qKey)
				}
				g := watchBuilds(t, s, &buildGate{step: "place", hold: func(nth, _ int) bool { return nth == 1 }})
				first := askNow(func() string { return sc.ask(s, p1, query) })
				waitFor(t, "the first build is held", func() bool { return g.held() == 1 })
				other := askNow(func() string { return sc.ask(s, q1, query) })
				again := askNow(func() string { return sc.ask(s, p2, query) })
				waitFor(t, "both came", func() bool {
					n := sc.answers(ci).Waiting(pKey)
					return n == 2 || n == 1 && other.finished()
				})
				g.open()
				for _, c := range []struct {
					who string
					ctx context.Context
					a   *asking
				}{{"p1", p1, first}, {"q1", q1, other}, {"p2", p2, again}} {
					if got, want := c.a.wait(t), sc.own(s, c.ctx, query); got != want {
						t.Errorf("%s:\n got %.300s\nwant %.300s", c.who, got, want)
					}
				}
				if p, q := g.builds(pKey), g.builds(qKey); p != 2 || q != 1 {
					t.Errorf("builds: %d of the first decision (want 2: its own and the next), %d of the other (want its own)", p, q)
				}
			})
		}
	}
}

// Three hundred people of three decisions opening the page at once, half of them polling with revisions of their own from
// before, get one answer per decision from two builds each, and no place is held while they wait.
func TestACrowdOnThePodsPageBuildsOncePerDecision(t *testing.T) {
	pods := sharePods(rand.New(rand.NewSource(3)), 3000)
	grants := map[string][]string{}
	var asks []shareAsk
	for i := 0; i < 300; i++ {
		user := fmt.Sprintf("u%03d@example.com", i)
		var ctx context.Context
		switch i % 3 {
		case 0:
			ctx, grants[user] = wideCaller(user), []string{""}
		case 1:
			ctx, grants[user] = grantCaller(user, "team", "shop"), []string{"team", "shop"}
		default:
			ctx, grants[user] = grantCaller(user, "bulk"), []string{"bulk"}
		}
		q := PodPageQuery{Limit: 50, Sort: "name"}
		if i%2 == 1 {
			q.Revision = fmt.Sprintf("old-%d", i)
		}
		asks = append(asks, shareAsk{ctx, q})
	}
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pods, grants)
			got, keys, g := crowdOf(t, s, ci, sc, asks, func() {
				if n := len(podRowSlots); n != 0 {
					t.Errorf("%d places held while the first builds were held before theirs and the crowd waited, want 0", n)
				}
			})
			byKey := map[string]string{}
			for i, a := range asks {
				if keys[i] == "" {
					t.Fatalf("caller %d: no build", i)
				}
				if first, ok := byKey[keys[i]]; ok && first != got[i] {
					t.Fatalf("caller %d: another answer than its key's first", i)
				}
				byKey[keys[i]] = got[i]
				if i < 6 {
					if want := sc.own(s, a.ctx, a.q); got[i] != want {
						t.Errorf("caller %d:\n got %.300s\nwant %.300s", i, got[i], want)
					}
				}
			}
			if len(byKey) != 3 {
				t.Errorf("%d keys, want one per decision", len(byKey))
			}
			for key := range byKey {
				if n := g.builds(key); n != 2 {
					t.Errorf("%d builds of a key, want 2 (the first and one for everyone who came during it)", n)
				}
			}
			if n := len(podRowSlots); n != 0 {
				t.Errorf("%d places still held", n)
			}
			waitFor(t, "no build left under way", func() bool { return sc.answers(ci).Keys() == 0 })
		})
	}
}

// While a build holds its place and its rows, the twenty who came during it wait for the next build holding no place.
func TestWaitersOnAPodAnswerHoldNoPlace(t *testing.T) {
	pods := sharePods(rand.New(rand.NewSource(4)), 500)
	grants := map[string][]string{}
	callers := make([]context.Context, 21)
	for i := range callers {
		user := fmt.Sprintf("u%02d@example.com", i)
		callers[i], grants[user] = wideCaller(user), []string{""}
	}
	q := PodPageQuery{Limit: 50}
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pods, grants)
			g := watchBuilds(t, s, &buildGate{step: "rows", hold: func(nth, _ int) bool { return nth == 1 }})
			first := askNow(func() string { return sc.ask(s, callers[0], q) })
			waitFor(t, "the first build holds its place and its rows", func() bool { return g.held() == 1 })
			key := keyOf(t, s, sc, callers[0], q)
			var rest []*asking
			for _, ctx := range callers[1:] {
				rest = append(rest, askNow(func() string { return sc.ask(s, ctx, q) }))
			}
			waitFor(t, "twenty wait for the next build", func() bool { return sc.answers(ci).Waiting(key) == 20 })
			if n := len(podRowSlots); n != 1 {
				t.Errorf("%d places held while one build ran and twenty waited, want 1", n)
			}
			g.open()
			want := sc.own(s, callers[0], q)
			if got := first.wait(t); got != want {
				t.Errorf("the first:\n got %.300s\nwant %.300s", got, want)
			}
			for i, a := range rest {
				if got := a.wait(t); got != want {
					t.Errorf("caller %d:\n got %.300s\nwant %.300s", i+1, got, want)
				}
			}
			if n := g.builds(key); n != 2 {
				t.Errorf("%d builds, want 2", n)
			}
			if n := len(podRowSlots); n != 0 {
				t.Errorf("%d places still held", n)
			}
		})
	}
}

// Callers whose only difference is the revision their page is from, each poller with its own, wait on one build.
func TestCallersWhoseOnlyDifferenceIsTheirRevisionShareOneBuild(t *testing.T) {
	grants := map[string][]string{}
	var asks []shareAsk
	for i := 0; i < 16; i++ {
		user := fmt.Sprintf("u%02d@example.com", i)
		grants[user] = []string{""}
		q := PodPageQuery{Limit: 50}
		if i > 5 {
			q.Revision = fmt.Sprintf("e-%d.all", i)
		}
		asks = append(asks, shareAsk{wideCaller(user), q})
	}
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pagePods(), grants)
			got, keys, g := crowdOf(t, s, ci, sc, asks, nil)
			for i, a := range asks {
				if keys[i] != keys[0] {
					t.Fatalf("caller %d has a key of its own", i)
				}
				if want := sc.own(s, a.ctx, a.q); got[i] != want {
					t.Errorf("caller %d:\n got %.300s\nwant %.300s", i, got[i], want)
				}
			}
			if n := g.builds(keys[0]); n != 2 {
				t.Errorf("%d builds for sixteen callers of one decision and query, want 2", n)
			}
		})
	}
}

// Every field of the page's query is in its key, the caller's revision never; the decision is in it as a list in its
// order, the node map's key holds its namespace and search, and a key holding bytes that are not UTF-8 is not shared.
func TestEveryPodPageQueryFieldIsInTheShareKey(t *testing.T) {
	text := func(k podShareKey) string {
		t.Helper()
		s, ok := k.text()
		if !ok {
			t.Fatalf("%+v is not shared", k)
		}
		return s
	}
	set := &podRowSet{revision: "e-1.all", all: true}
	base := text(podPageShareKey(set, PodPageQuery{}))
	typ := reflect.TypeOf(PodPageQuery{})
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		q := PodPageQuery{}
		v := reflect.ValueOf(&q).Elem().Field(i)
		switch v.Kind() {
		case reflect.String:
			v.SetString("x")
		case reflect.Bool:
			v.SetBool(true)
		case reflect.Int:
			v.SetInt(7)
		case reflect.Slice:
			v.Set(reflect.ValueOf([]string{"team/app"}))
		case reflect.Interface:
			var sel labels.Selector = labels.Everything()
			v.Set(reflect.ValueOf(&sel).Elem())
		default:
			t.Fatalf("%s is a %s: say here how a caller's value of it changes", field.Name, v.Kind())
		}
		changed := text(podPageShareKey(set, q)) != base
		switch {
		case field.Name == "Revision" && changed:
			t.Error("the caller's revision is in the key: pollers with revisions of their own would each have a build")
		case field.Name != "Revision" && !changed:
			t.Errorf("%s is not in the key: two callers differing only in it would get one answer", field.Name)
		}
	}
	for name, other := range map[string]*podRowSet{
		"revision":   {revision: "e-2.all", all: true},
		"all":        {revision: "e-1.all"},
		"namespaces": {revision: "e-1.all", all: true, namespaces: []string{"a"}},
	} {
		if text(podPageShareKey(other, PodPageQuery{})) == base || text(podNodesShareKey(other, "", "")) == text(podNodesShareKey(set, "", "")) {
			t.Errorf("the set's %s is not in the key", name)
		}
	}
	inOrder := func(namespaces ...string) string {
		return text(podPageShareKey(&podRowSet{revision: "r", namespaces: namespaces}, PodPageQuery{}))
	}
	if inOrder("a", "b") == inOrder("b", "a") {
		t.Error("[a, b] and [b, a] have one key")
	}
	if text(podPageShareKey(set, PodPageQuery{ServiceAccounts: []string{"a/x", "b/y"}})) == text(podPageShareKey(set, PodPageQuery{ServiceAccounts: []string{"b/y", "a/x"}})) {
		t.Error("service accounts in two orders have one key")
	}
	nodes := text(podNodesShareKey(set, "", ""))
	if text(podNodesShareKey(set, "team", "")) == nodes || text(podNodesShareKey(set, "", "app")) == nodes ||
		text(podNodesShareKey(set, "team", "")) == text(podNodesShareKey(set, "", "team")) {
		t.Error("the node map's key does not hold its namespace and its search apart")
	}
	// a string of the key that is not UTF-8, in any field the page's query has, keeps it from being shared; the caller's
	// revision is not in the key
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		q := PodPageQuery{}
		v := reflect.ValueOf(&q).Elem().Field(i)
		switch v.Kind() {
		case reflect.String:
			v.SetString("a\xffb")
		case reflect.Slice:
			v.Set(reflect.ValueOf([]string{"team/app", "shop/\xfe"}))
		default:
			continue
		}
		_, shared := podPageShareKey(set, q).text()
		switch {
		case field.Name == "Revision" && !shared:
			t.Error("a caller's revision that is not UTF-8 keeps the page from being shared, though the key leaves it out")
		case field.Name != "Revision" && shared:
			t.Errorf("%s that is not UTF-8 is shared: json.Marshal may write it as another key's U+FFFD", field.Name)
		}
	}
	for _, k := range []podShareKey{
		podNodesShareKey(set, "\xff", ""),
		podNodesShareKey(set, "", "\xfe"),
		podPageShareKey(&podRowSet{revision: "r", namespaces: []string{"a", "\xff"}}, PodPageQuery{}),
		podPageShareKey(&podRowSet{revision: "r\xbd", all: true}, PodPageQuery{}),
	} {
		if _, ok := k.text(); ok {
			t.Errorf("%+v is shared: json.Marshal may write it as another key's U+FFFD", k)
		}
	}
	for _, k := range []podShareKey{
		podPageShareKey(set, PodPageQuery{Search: "\ufffd"}),
		podNodesShareKey(set, "", "a\ufffdb"),
	} {
		if _, ok := k.text(); !ok {
			t.Errorf("%+v is not shared: U+FFFD itself is UTF-8", k)
		}
	}
}

// Two callers of one decision whose searches differ only in bytes that are not UTF-8 each build their own answer, the
// second while the first is held; two asking for U+FFFD itself wait on one build as any others.
func TestAPodAnswerAskedWithBytesThatAreNotUTF8IsBuiltForItsCallerAlone(t *testing.T) {
	grants := map[string][]string{"a@example.com": {""}, "b@example.com": {""}}
	a, b := wideCaller("a@example.com"), wideCaller("b@example.com")
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pagePods(), grants)
			qa, qb := PodPageQuery{Limit: 50, Search: "p\xbd"}, PodPageQuery{Limit: 50, Search: "p\xbe"}
			g := watchBuilds(t, s, &buildGate{step: "place", hold: func(nth, _ int) bool { return nth == 1 }})
			first := askNow(func() string { return sc.ask(s, a, qa) })
			waitFor(t, "the first build is held", func() bool { return g.held() == 1 })
			other := askNow(func() string { return sc.ask(s, b, qb) })
			waitFor(t, "the second builds its own answer while the first is held", other.finished)
			if got, want := other.wait(t), sc.own(s, b, qb); got != want {
				t.Errorf("the second:\n got %.300s\nwant %.300s", got, want)
			}
			g.open()
			if got, want := first.wait(t), sc.own(s, a, qa); got != want {
				t.Errorf("the first:\n got %.300s\nwant %.300s", got, want)
			}
			if n := g.steps("rows"); n != 2 {
				t.Errorf("%d builds, want one for each", n)
			}

			q := PodPageQuery{Limit: 50, Search: "p\ufffd"}
			key := keyOf(t, s, sc, a, q)
			g = watchBuilds(t, s, &buildGate{step: "place", hold: func(nth, _ int) bool { return nth == 1 }})
			first = askNow(func() string { return sc.ask(s, a, q) })
			waitFor(t, "the first build of U+FFFD is held", func() bool { return g.held() == 1 })
			other = askNow(func() string { return sc.ask(s, b, q) })
			waitFor(t, "the second waits for the next build", func() bool { return sc.answers(ci).Waiting(key) == 1 })
			g.open()
			for _, c := range []struct {
				who string
				ctx context.Context
				a   *asking
			}{{"the first", a, first}, {"the second", b, other}} {
				if got, want := c.a.wait(t), sc.own(s, c.ctx, q); got != want {
					t.Errorf("%s of U+FFFD:\n got %.300s\nwant %.300s", c.who, got, want)
				}
			}
		})
	}
}

// A build that read its rows before a caller came does not answer it: a pod the store has meanwhile, which its handler has
// not counted yet so the revision is the same, is in the next build, which the later caller gets.
func TestAPodPageRunStartedBeforeACallerCameDoesNotAnswerIt(t *testing.T) {
	grants := map[string][]string{"a@example.com": {""}, "b@example.com": {""}}
	a, b := wideCaller("a@example.com"), wideCaller("b@example.com")
	q := PodPageQuery{Limit: 50}
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pagePods(), grants)
			g := watchBuilds(t, s, &buildGate{step: "rows", hold: func(nth, _ int) bool { return nth == 1 }})
			first := askNow(func() string { return sc.ask(s, a, q) })
			waitFor(t, "the first build has read its rows", func() bool { return g.held() == 1 })
			before := ci.podRevision()
			if err := ci.pods.Add(row("a", "p-late", nil)); err != nil {
				t.Fatal(err)
			}
			if ci.podRevision() != before {
				t.Fatal("the store's own add moved the revision")
			}
			key := keyOf(t, s, sc, a, q)
			if keyOf(t, s, sc, b, q) != key {
				t.Fatal("the later caller has another key")
			}
			later := askNow(func() string { return sc.ask(s, b, q) })
			waitFor(t, "the later caller waits", func() bool { return sc.answers(ci).Waiting(key) == 1 })
			g.open()
			old, got := first.wait(t), later.wait(t)
			if want := sc.own(s, b, q); got != want {
				t.Errorf("the later caller:\n got %.300s\nwant %.300s", got, want)
			}
			if old == got {
				t.Error("the later caller got the answer of a build that read its rows before it came")
			}
			if sc.name == "pods-page" && (strings.Contains(old, "p-late") || !strings.Contains(got, "p-late")) {
				t.Errorf("the pod that came between: in the first answer %v, in the later one %v", strings.Contains(old, "p-late"), strings.Contains(got, "p-late"))
			}
		})
	}
}

// A build at the revision before a change answers no one who comes after it: the change moves the revision, so they have
// a key of their own and their answer, with the change in it, while that build is still held. Each answer carries the
// revision it was asked at; a poll at the one before gets the new answer, and one at the new one is unchanged.
func TestAMovedRevisionGivesANewPodAnswer(t *testing.T) {
	grants := map[string][]string{"a@example.com": {""}, "b@example.com": {""}}
	a, b := wideCaller("a@example.com"), wideCaller("b@example.com")
	q := PodPageQuery{Limit: 50}
	// the later caller's build takes a place while the first holds one, on one CPU too
	places := podRowSlots
	podRowSlots = make(chan struct{}, 2)
	t.Cleanup(func() { podRowSlots = places })
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			cs := fake.NewSimpleClientset(pagePods()...)
			ci := newClusterInformers(cs, time.Hour, nil)
			t.Cleanup(ci.stopNow)
			if !ci.waitSynced(context.Background(), 5*time.Second) {
				t.Fatal("informers did not sync")
			}
			s, bundle := (&clusterAPI{review: rbac(grants)}).start(t)
			bundle.inf = ci
			s.podClock = func() time.Time { return shareNow }
			_, _, _, before, err := decided(s, a, "")
			if err != nil {
				t.Fatal(err)
			}
			g := watchBuilds(t, s, &buildGate{step: "rows", hold: func(nth, _ int) bool { return nth == 1 }})
			first := askNow(func() string { return sc.ask(s, a, q) })
			waitFor(t, "the first build has read its rows", func() bool { return g.held() == 1 })
			was := ci.podRevision()
			p1, err := cs.CoreV1().Pods("a").Get(context.Background(), "p1", metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			p1.Status.Phase = corev1.PodFailed
			if _, err := cs.CoreV1().Pods("a").UpdateStatus(context.Background(), p1, metav1.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
			waitFor(t, "the change moves the revision", func() bool { return ci.podRevision() != was })
			_, _, _, after, err := decided(s, b, "")
			if err != nil || after == before {
				t.Fatalf("the revision after the change: %q, before it %q, %v", after, before, err)
			}
			poll := q
			poll.Revision = before
			later := askNow(func() string { return sc.ask(s, b, poll) })
			waitFor(t, "the later caller has its answer while the build at the revision before is held", later.finished)
			got := later.wait(t)
			if want := sc.own(s, b, poll); got != want {
				t.Errorf("the later caller:\n got %.300s\nwant %.300s", got, want)
			}
			g.open()
			old := first.wait(t)
			if !strings.Contains(old, `"revision":"`+before+`"`) || !strings.Contains(got, `"revision":"`+after+`"`) {
				t.Errorf("revisions: the first answer's is not %s or the later one's not %s:\n%.300s\n%.300s", before, after, old, got)
			}
			if sc.name == "pods-page" && (strings.Contains(old, `"error":2`) || !strings.Contains(got, `"error":2`)) {
				t.Errorf("the change: in the first answer %v, in the later one %v", strings.Contains(old, `"error":2`), strings.Contains(got, `"error":2`))
			}
			poll.Revision = after
			if got := sc.ask(s, b, poll); !strings.Contains(got, `"unchanged":true`) {
				t.Errorf("a poll at the new revision: %.300s", got)
			}
		})
	}
}

// A poll at the current revision is answered unchanged at once, while a build of the same decision and query is under
// way: it waits for no build and takes no place.
func TestAPollerAtTheCurrentRevisionTakesNoPlaceAndNoRun(t *testing.T) {
	grants := map[string][]string{"a@example.com": {""}, "b@example.com": {""}}
	a, b := wideCaller("a@example.com"), wideCaller("b@example.com")
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pagePods(), grants)
			_, _, _, rev, err := decided(s, b, "")
			if err != nil {
				t.Fatal(err)
			}
			g := watchBuilds(t, s, &buildGate{step: "rows", hold: func(nth, _ int) bool { return nth == 1 }})
			first := askNow(func() string { return sc.ask(s, a, PodPageQuery{Limit: 50}) })
			waitFor(t, "a build holds its place", func() bool { return g.held() == 1 })
			key := keyOf(t, s, sc, a, PodPageQuery{Limit: 50})
			poll := PodPageQuery{Limit: 50, Revision: rev}
			got := askNow(func() string { return sc.ask(s, b, poll) }).wait(t)
			if want := sc.own(s, b, poll); got != want || !strings.Contains(got, `"unchanged":true`) {
				t.Errorf("the poll:\n got %.300s\nwant %.300s", got, want)
			}
			if n := sc.answers(ci).Waiting(key); n != 0 {
				t.Errorf("%d wait for the next build, want 0", n)
			}
			if n := len(podRowSlots); n != 1 {
				t.Errorf("%d places held, want the build's 1", n)
			}
			g.open()
			first.wait(t)
			if n := g.steps("rows"); n != 1 {
				t.Errorf("%d builds, want the first only", n)
			}
		})
	}
}

// The shared answers are response.JSON's bytes of the answer each caller was given alone, for a page, a sorted one, an
// unchanged poll, a search that is not UTF-8 (built for its caller alone), a refusal and a namespace the caller may list.
func TestTheSharedPodAnswerIsTheBytesResponseJSONWrites(t *testing.T) {
	s, _ := shareCluster(t, pagePods(), map[string][]string{"a@example.com": {""}, "b@example.com": {"b"}})
	a, b := wideCaller("a@example.com"), wideCaller("b@example.com")
	_, _, _, rev, err := decided(s, a, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		ctx context.Context
		q   PodPageQuery
	}{
		{a, PodPageQuery{Limit: 50}},
		{a, PodPageQuery{Limit: 1, Sort: "age", Desc: true}},
		{a, PodPageQuery{Limit: 50, Revision: rev}},
		{a, PodPageQuery{Limit: 50, Search: "p\xff"}},
		{b, PodPageQuery{Limit: 50}},
		{b, PodPageQuery{Namespace: "b", Limit: 50}},
	} {
		for _, sc := range podScreens {
			if got, want := sc.ask(s, c.ctx, c.q), sc.own(s, c.ctx, c.q); got != want {
				t.Errorf("%s %+v:\n got %.300s\nwant %.300s", sc.name, c.q, got, want)
			}
		}
		page, err := s.GetPodPage(c.ctx, c.q)
		if got := said(s.GetPodPageJSON(c.ctx, c.q)); err == nil && got != written(page) {
			t.Errorf("%+v: GetPodPageJSON is not response.JSON of GetPodPage:\n%.300s\n%.300s", c.q, got, written(page))
		}
	}
}

// The trail of a caller answered by the build another request started says so; the caller who built its own answer and
// the first who waited, whose request the next build was started for, have no such line.
func TestAPodAnswerWaitersTrailSaysAnotherRequestsReadAnsweredIt(t *testing.T) {
	grants := map[string][]string{"a@example.com": {""}, "b@example.com": {""}, "c@example.com": {""}}
	q := PodPageQuery{Limit: 50}
	joined := func(r *accesstrail.Recorder) int {
		n := 0
		for _, req := range r.Snapshot().Requests {
			if req.Source == "cache" && req.Cache == "the same read of another request" {
				n++
			}
		}
		return n
	}
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pagePods(), grants)
			key := keyOf(t, s, sc, wideCaller("a@example.com"), q)
			ra, rb, rc := &accesstrail.Recorder{}, &accesstrail.Recorder{}, &accesstrail.Recorder{}
			a := accesstrail.NewContext(wideCaller("a@example.com"), ra)
			b := accesstrail.NewContext(wideCaller("b@example.com"), rb)
			c := accesstrail.NewContext(wideCaller("c@example.com"), rc)
			g := watchBuilds(t, s, &buildGate{step: "place", hold: func(nth, _ int) bool { return nth == 1 }})
			first := askNow(func() string { return sc.ask(s, a, q) })
			waitFor(t, "the first build is held", func() bool { return g.held() == 1 })
			second := askNow(func() string { return sc.ask(s, b, q) })
			waitFor(t, "the second waits for the next build", func() bool { return sc.answers(ci).Waiting(key) == 1 })
			third := askNow(func() string { return sc.ask(s, c, q) })
			waitFor(t, "the third waits for it too", func() bool { return sc.answers(ci).Waiting(key) == 2 })
			g.open()
			want := sc.own(s, wideCaller("a@example.com"), q)
			for _, w := range []struct {
				who   string
				a     *asking
				r     *accesstrail.Recorder
				lines int
			}{{"the first, who built its own answer", first, ra, 0}, {"the second, the next build's first", second, rb, 0}, {"the third", third, rc, 1}} {
				if got := w.a.wait(t); got != want {
					t.Errorf("%s:\n got %.300s\nwant %.300s", w.who, got, want)
				}
				if n := joined(w.r); n != w.lines {
					t.Errorf("%s has %d lines of another request's read, want %d", w.who, n, w.lines)
				}
			}
		})
	}
}

// One caller leaving while it waits for the next build gets its own error at once and the others the answer; when all
// who wait leave while the build waits for a place, it stops waiting, builds nothing and keeps no place.
func TestPodAnswerWaitersThatLeave(t *testing.T) {
	grants := map[string][]string{"a@example.com": {""}, "b@example.com": {""}, "c@example.com": {""}}
	a, b, c := wideCaller("a@example.com"), wideCaller("b@example.com"), wideCaller("c@example.com")
	q := PodPageQuery{Limit: 50}
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pagePods(), grants)
			key := keyOf(t, s, sc, a, q)
			g := watchBuilds(t, s, &buildGate{step: "place", hold: func(nth, _ int) bool { return nth == 1 }})
			first := askNow(func() string { return sc.ask(s, a, q) })
			waitFor(t, "the first build is held", func() bool { return g.held() == 1 })
			leaving, leave := context.WithCancel(b)
			defer leave()
			left := askNow(func() string { return sc.ask(s, leaving, q) })
			stays := askNow(func() string { return sc.ask(s, c, q) })
			waitFor(t, "two wait", func() bool { return sc.answers(ci).Waiting(key) == 2 })
			leave()
			if got := left.wait(t); got != "error: "+context.Canceled.Error() {
				t.Errorf("the one who left: %.200s", got)
			}
			waitFor(t, "one waits", func() bool { return sc.answers(ci).Waiting(key) == 1 })
			g.open()
			want := sc.own(s, c, q)
			if got := first.wait(t); got != want {
				t.Errorf("the first: %.200s", got)
			}
			if got := stays.wait(t); got != want {
				t.Errorf("the one who stayed: %.200s", got)
			}

			// every place taken: the first build and the next both wait for one, and everyone leaves; another query, so
			// nothing is left of the key above
			q2 := PodPageQuery{Limit: 50, Search: "p"}
			key2 := keyOf(t, s, sc, a, q2)
			for range cap(podRowSlots) {
				podRowSlots <- struct{}{}
			}
			var freed sync.Once
			free := func() {
				freed.Do(func() {
					for range cap(podRowSlots) {
						<-podRowSlots
					}
				})
			}
			t.Cleanup(free)
			g = watchBuilds(t, s, &buildGate{})
			ctxA, cancelA := context.WithCancel(a)
			ctxB, cancelB := context.WithCancel(b)
			ctxC, cancelC := context.WithCancel(c)
			defer cancelA()
			defer cancelB()
			defer cancelC()
			alone := askNow(func() string { return sc.ask(s, ctxA, q2) })
			waitFor(t, "the first build waits for a place", func() bool { return g.steps("place") == 1 })
			waiters := []*asking{askNow(func() string { return sc.ask(s, ctxB, q2) }), askNow(func() string { return sc.ask(s, ctxC, q2) })}
			waitFor(t, "two wait for the next build", func() bool { return sc.answers(ci).Waiting(key2) == 2 })
			cancelA()
			if got := alone.wait(t); got != "error: "+context.Canceled.Error() {
				t.Errorf("the first, gone while it waited for a place: %.200s", got)
			}
			waitFor(t, "the next build waits for a place", func() bool { return g.steps("place") == 2 })
			cancelB()
			cancelC()
			for _, w := range waiters {
				if got := w.wait(t); got != "error: "+context.Canceled.Error() {
					t.Errorf("a waiter gone: %.200s", got)
				}
			}
			// the first build and the next one no one waits for both stop waiting for a place before one is free
			waitFor(t, "the next build stops waiting for a place", func() bool { return g.steps("no place") == 2 })
			free()
			if n := g.steps("rows"); n != 0 {
				t.Errorf("%d builds read the rows for no one", n)
			}
			if n := len(podRowSlots); n != 0 {
				t.Errorf("%d places held after everyone left", n)
			}
			waitFor(t, "no build left under way after everyone left", func() bool { return sc.answers(ci).Keys() == 0 })
		})
	}
}

// listingService serves api to callers whose pod rows are listed as themselves: a bundle that keeps no informers, or one
// whose informers start as kubeast:cache, which api may refuse.
func listingService(t *testing.T, api *clusterAPI, noInformers bool) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(srv.Close)
	userCfg := &rest.Config{Host: srv.URL, QPS: -1}
	wrapPerson(userCfg, "default")
	cs, err := kubernetes.NewForConfig(userCfg)
	if err != nil {
		t.Fatal(err)
	}
	cacheCfg := &rest.Config{Host: srv.URL, QPS: -1, Impersonate: rest.ImpersonationConfig{UserName: overviewCacheUser, Groups: []string{auth.GroupAuthenticated, auth.GroupViewer}}}
	cacheClient, err := kubernetes.NewForConfig(cacheCfg)
	if err != nil {
		t.Fatal(err)
	}
	b := &clientBundle{clientset: cs, authz: cs.AuthorizationV1(), cacheClient: cacheClient, id: "default", noInformers: noInformers}
	t.Cleanup(func() { _ = b.Close() })
	s := &Service{cache: cache.New("", 0, 0, "")}
	s.defaultBundle.Store(b)
	s.podClock = func() time.Time { return shareNow }
	return s
}

// Rows listed as the caller — no informers, kubeast:cache refused the pods, or a bundle closed (evicted, its kubeconfig
// replaced) while the requests hold it, which starts no informers — are each caller's own: three people at once list the
// pods once each as themselves, and nothing is built for them together.
func TestThePodListFallbackIsNeverShared(t *testing.T) {
	users := []string{"a@example.com", "b@example.com", "c@example.com"}
	for _, c := range []struct {
		name                string
		noInformers, closed bool
	}{{name: "no-informers", noInformers: true}, {name: "cache-refused"}, {name: "bundle-closed", closed: true}} {
		for _, sc := range podScreens {
			t.Run(c.name+"/"+sc.name, func(t *testing.T) {
				api := &clusterAPI{pods: podsOnNodes(), review: rbac(map[string][]string{"a@example.com": {""}, "b@example.com": {""}, "c@example.com": {""}})}
				api.may = func(user, _, _, _, _ string) bool { return c.closed || user != overviewCacheUser }
				s := listingService(t, api, c.noInformers)
				if c.closed {
					_ = s.defaultBundle.Load().Close()
				}
				g := watchBuilds(t, s, &buildGate{})
				going := make([]*asking, len(users))
				for i, user := range users {
					ctx := wideCaller(user)
					going[i] = askNow(func() string { return sc.ask(s, ctx, PodPageQuery{Limit: 50}) })
				}
				for i, user := range users {
					if got := going[i].wait(t); !strings.Contains(got, `"source":"list"`) {
						t.Errorf("%s: %.200s", user, got)
					}
					if n := api.count(func(call apiCall) bool { return call.user == user && call.verb == "list" && call.resource == "pods" }); n != 1 {
						t.Errorf("%s listed the pods %d times as itself, want once", user, n)
					}
				}
				if n := g.steps("place"); n != 0 {
					t.Errorf("%d shared builds of listed rows", n)
				}
				if n := len(podRowSlots); n != 0 {
					t.Errorf("%d places still held", n)
				}
			})
		}
	}
}

// A build that panics answers everyone who waited on it with flight.ErrPanicked, gives its place back, and the process
// goes on: the first caller has its own answer and the next one is answered as before.
func TestAPanickingPodAnswerRunAnswersItsWaitersAndGivesItsPlaceBack(t *testing.T) {
	grants := map[string][]string{"a@example.com": {""}, "b@example.com": {""}, "c@example.com": {""}, "d@example.com": {""}}
	a := wideCaller("a@example.com")
	q := PodPageQuery{Limit: 50}
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pagePods(), grants)
			g := watchBuilds(t, s, &buildGate{step: "place", hold: func(nth, _ int) bool { return nth == 1 }, panics: func(nth int) bool { return nth == 2 }})
			first := askNow(func() string { return sc.ask(s, a, q) })
			waitFor(t, "the first build is held", func() bool { return g.held() == 1 })
			key := keyOf(t, s, sc, a, q)
			var waiters []*asking
			for _, user := range []string{"b@example.com", "c@example.com", "d@example.com"} {
				ctx := wideCaller(user)
				waiters = append(waiters, askNow(func() string { return sc.ask(s, ctx, q) }))
			}
			waitFor(t, "three wait", func() bool { return sc.answers(ci).Waiting(key) == 3 })
			g.open()
			if got, want := first.wait(t), sc.own(s, a, q); got != want {
				t.Errorf("the first:\n got %.300s\nwant %.300s", got, want)
			}
			for i, w := range waiters {
				if got := w.wait(t); !strings.HasPrefix(got, "error: "+flight.ErrPanicked.Error()) {
					t.Errorf("waiter %d: %.200s", i, got)
				}
			}
			waitFor(t, "the place goes back", func() bool { return len(podRowSlots) == 0 })
			if got, want := sc.ask(s, a, q), sc.own(s, a, q); got != want {
				t.Errorf("after the panic:\n got %.300s\nwant %.300s", got, want)
			}
		})
	}
}

// A build runs on the values of the request of the first who waited for it, here a reader of every namespace asking for
// namespace b; the grants limited to b who wait on the same build, one decision with it, get each their own answer.
func TestTheSharedBuildReadsNothingOfWhoAsks(t *testing.T) {
	grants := map[string][]string{"first@example.com": {""}, "wide@example.com": {""}, "g1@example.com": {"b"}, "g2@example.com": {"a", "b"}, "g3@example.com": {"b"}}
	first, wide := wideCaller("first@example.com"), wideCaller("wide@example.com")
	granted := []context.Context{grantCaller("g1@example.com", "b"), grantCaller("g2@example.com", "a", "b"), grantCaller("g3@example.com", "b", "c")}
	q := PodPageQuery{Namespace: "b", Limit: 50}
	for _, sc := range podScreens {
		t.Run(sc.name, func(t *testing.T) {
			s, ci := shareCluster(t, pagePods(), grants)
			key := keyOf(t, s, sc, first, q)
			for _, ctx := range append([]context.Context{wide}, granted...) {
				if keyOf(t, s, sc, ctx, q) != key {
					t.Fatal("a caller of the same decision has another key")
				}
			}
			g := watchBuilds(t, s, &buildGate{step: "place", hold: func(nth, _ int) bool { return nth == 1 }})
			held := askNow(func() string { return sc.ask(s, first, q) })
			waitFor(t, "the first build is held", func() bool { return g.held() == 1 })
			wideAsk := askNow(func() string { return sc.ask(s, wide, q) })
			waitFor(t, "the wide reader waits first", func() bool { return sc.answers(ci).Waiting(key) == 1 })
			var asks []*asking
			for _, ctx := range granted {
				asks = append(asks, askNow(func() string { return sc.ask(s, ctx, q) }))
			}
			waitFor(t, "the grants wait too", func() bool { return sc.answers(ci).Waiting(key) == 4 })
			g.open()
			held.wait(t)
			if got, want := wideAsk.wait(t), sc.own(s, wide, q); got != want {
				t.Errorf("the wide reader:\n got %.300s\nwant %.300s", got, want)
			}
			for i, a := range asks {
				if got, want := a.wait(t), sc.own(s, granted[i], q); got != want {
					t.Errorf("grant %d:\n got %.300s\nwant %.300s", i+1, got, want)
				}
			}
		})
	}
}

// BenchmarkPodPageCrowd is 500 people opening the Pods page of 50 000 pods at one moment: each page built by its caller
// as before ("each") and built once for everyone with one key ("shared"), with the builds of a crowd and the allocations.
func BenchmarkPodPageCrowd(b *testing.B) {
	objs := make([]k8sruntime.Object, 0, 50_000)
	for i := 0; i < 50_000; i++ {
		p := listedPod(fmt.Sprintf("bulk-%02d", i%40), fmt.Sprintf("node-%03d", i%1000), i)
		objs = append(objs, &p)
	}
	ci := newClusterInformers(fake.NewSimpleClientset(objs...), time.Hour, nil)
	defer ci.stopNow()
	if !ci.waitSynced(context.Background(), 2*time.Minute) {
		b.Fatal("informers did not sync")
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{inf: ci}) // no authz: every caller may list every pod
	q := PodPageQuery{Limit: 50, Sort: "name"}
	callers := make([]context.Context, 500)
	for i := range callers {
		callers[i] = wideCaller(fmt.Sprintf("u%03d@example.com", i))
	}
	crowd := func(ask func(ctx context.Context)) {
		var wg sync.WaitGroup
		for _, ctx := range callers {
			wg.Go(func() { ask(ctx) })
		}
		wg.Wait()
	}
	b.Run("each", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			crowd(func(ctx context.Context) {
				page, err := s.GetPodPage(ctx, q)
				if err != nil {
					b.Error(err)
					return
				}
				_ = answerBytes(page)
			})
		}
		b.ReportMetric(float64(len(callers)), "builds/crowd")
	})
	b.Run("shared", func(b *testing.B) {
		var builds atomic.Int64
		s.podBuildStep = func(_, step string) {
			if step == "rows" {
				builds.Add(1)
			}
		}
		b.ReportAllocs()
		crowds := 0
		for b.Loop() {
			crowds++
			crowd(func(ctx context.Context) {
				if _, err := s.GetPodPageJSON(ctx, q); err != nil {
					b.Error(err)
				}
			})
		}
		b.ReportMetric(float64(builds.Load())/float64(crowds), "builds/crowd")
	})
}
