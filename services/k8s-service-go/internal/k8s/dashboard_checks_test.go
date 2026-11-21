package k8s

import (
	"context"
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"sync"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
)

// dashboard is what the Dashboard reads as it opens: the namespace list, the overview, the pod page and the node list.
func dashboard(s *Service, ctx context.Context) {
	var wg sync.WaitGroup
	for _, read := range []func(){
		func() { _, _ = s.GetNamespaces(ctx) },
		func() { _, _ = s.GetClusterOverview(ctx) },
		func() { _, _ = s.GetPodPageJSON(ctx, PodPageQuery{Sort: "name", Limit: 50}) },
		func() { _, _ = s.GetNodesJSON(ctx) },
	} {
		wg.Add(1)
		go func() { defer wg.Done(); read() }()
	}
	wg.Wait()
}

// dashboardCluster is 20 namespaces, each with a pod, a Deployment and a Service, and a PVC in two of them.
func dashboardCluster() ([]string, []k8sruntime.Object) {
	var namespaces []string
	var objs []k8sruntime.Object
	for i := 0; i < 20; i++ {
		ns := fmt.Sprintf("ns-%02d", i)
		namespaces = append(namespaces, ns)
		objs = append(objs, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}, Status: corev1.NamespaceStatus{Phase: corev1.NamespaceActive}},
			overviewPod(ns, "p", corev1.PodRunning),
			&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "d"}},
			&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "s"}})
		if i < 2 {
			objs = append(objs, &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "c"}})
		}
	}
	return namespaces, objs
}

func callsByKind(calls []apiCall) string {
	byKind := map[string]int{}
	for _, c := range calls {
		byKind[c.verb+" "+c.resource]++
	}
	kinds := make([]string, 0, len(byKind))
	for k, n := range byKind {
		kinds = append(kinds, fmt.Sprintf("%s=%d", k, n))
	}
	slices.Sort(kinds)
	return strings.Join(kinds, " ")
}

// The requests one person's Dashboard makes to the cluster as that person, opened and opened again within the
// minute its access answers are remembered.
func TestTheDashboardsRequestsAsThePerson(t *testing.T) {
	namespaces, objs := dashboardCluster()
	grants := map[string][]string{"wide@example.com": {""}, "twenty@example.com": namespaces}
	people := []struct {
		user                string
		ctx                 context.Context
		firstWant, nextWant int
	}{
		{"wide@example.com", wideCaller("wide@example.com"), 7, 0},
		// a question per namespace for pods, Deployments, Services and reading the namespace, two for the PVCs and the
		// node list as the person (101 and 21 when every namespace was asked about every kind and read every time)
		{"twenty@example.com", grantCaller("twenty@example.com", namespaces...), 4*20 + 2 + 1, 1},
	}
	var table []string
	for _, p := range people {
		api := &clusterAPI{namespaces: namespaces, review: rbac(grants)}
		s, _ := api.start(t, objs...)
		dashboard(s, p.ctx)
		first := api.callsOf(p.user)
		dashboard(s, p.ctx)
		next := api.callsOf(p.user)[len(first):]
		table = append(table, fmt.Sprintf("%-20s first %3d (%s)\n%-20s again %3d (%s)", p.user, len(first), callsByKind(first), "", len(next), callsByKind(next)))
		if p.firstWant >= 0 && len(first) != p.firstWant {
			t.Errorf("%s: %d requests on the first open, want %d", p.user, len(first), p.firstWant)
		}
		if p.nextWant >= 0 && len(next) != p.nextWant {
			t.Errorf("%s: %d requests on the open within the minute, want %d", p.user, len(next), p.nextWant)
		}
	}
	t.Log("the Dashboard's requests as the person:\n" + strings.Join(table, "\n"))
}

// A grant's overview is what asking about every kind in every namespace gives: each count added up over the namespaces
// the cluster lets the caller list that kind in, null and refused where it lets it in none — over random clusters and
// answers, with no more questions than one per kind and namespace.
func TestAGrantsOverviewIsWhatAskingEveryNamespaceGives(t *testing.T) {
	rng := rand.New(rand.NewPCG(7, 15))
	kinds := []string{"pods", "services", "deployments", "persistentvolumeclaims"}
	phases := []corev1.PodPhase{corev1.PodRunning, corev1.PodPending, corev1.PodFailed, corev1.PodSucceeded, ""}
	for run := 0; run < 60; run++ {
		n := 1 + rng.IntN(6)
		var scope []string
		var objs []k8sruntime.Object
		held := map[string]int{} // "resource@namespace" → objects
		phaseOf := map[string]map[string]int{}
		for i := 0; i < n; i++ {
			ns := fmt.Sprintf("ns-%d", i)
			scope = append(scope, ns)
			objs = append(objs, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})
			phaseOf[ns] = map[string]int{}
			for _, kind := range kinds {
				for j := range []int{0, 0, 1, 2}[rng.IntN(4)] {
					name := fmt.Sprintf("%s-%d", kind, j)
					meta := metav1.ObjectMeta{Namespace: ns, Name: name}
					switch kind {
					case "pods":
						phase := phases[rng.IntN(len(phases))]
						objs = append(objs, overviewPod(ns, name, phase))
						phaseOf[ns][overviewPhase(string(phase))]++
					case "services":
						objs = append(objs, &corev1.Service{ObjectMeta: meta})
					case "deployments":
						objs = append(objs, &appsv1.Deployment{ObjectMeta: meta})
					default:
						objs = append(objs, &corev1.PersistentVolumeClaim{ObjectMeta: meta})
					}
					held[kind+"@"+ns]++
				}
			}
		}
		// outside the grant, objects the caller may list that it must not be counted
		objs = append(objs, overviewPod("other", "p", corev1.PodRunning), &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "other", Name: "s"}})
		share := []float64{0, 0.3, 0.7, 1}[rng.IntN(4)]
		may := map[string]bool{"pods@other": true, "services@other": true}
		for _, ns := range scope {
			for _, kind := range kinds {
				may[kind+"@"+ns] = rng.Float64() < share
			}
		}
		review := func(_ string, ra authorizationv1.ResourceAttributes) bool {
			return ra.Verb == "list" && may[ra.Resource+"@"+ra.Namespace]
		}
		api := &clusterAPI{namespaces: scope, review: review}
		s, _ := api.start(t, objs...)
		grant := scope
		if rng.IntN(3) == 0 { // a grant naming a namespace twice counts it once
			grant = append(slices.Clone(scope), scope[0])
		}
		got, err := s.GetClusterOverview(grantCaller("u@example.com", grant...))
		if err != nil {
			t.Fatal(err)
		}

		want := map[string]interface{}{"scoped": true, "total_namespaces": n, "total_pvs": 0, "node_count": 0}
		var refused []string
		for _, c := range overviewCounts {
			if !c.namespaced {
				continue
			}
			total, listed := 0, false
			status := map[string]int{"Running": 0, "Pending": 0, "Failed": 0, "Succeeded": 0, "Unknown": 0}
			for _, ns := range scope {
				if may[c.resource+"@"+ns] {
					listed = true
					total += held[c.resource+"@"+ns]
					for phase, m := range phaseOf[ns] {
						status[phase] += m
					}
				}
			}
			switch {
			case !listed:
				want[c.key] = nil
				refused = append(refused, c.resource)
				if c.key == "total_pods" {
					want["pod_status"] = nil
				}
			default:
				want[c.key] = total
				if c.key == "total_pods" {
					want["pod_status"] = status
				}
			}
		}
		if refused != nil {
			want["refused"] = refused
		}
		delete(got, "cluster_version")
		if answerJSON(t, got) != answerJSON(t, want) {
			t.Fatalf("run %d (%d namespaces, share %.1f):\n got %s\nwant %s", run, n, share, answerJSON(t, got), answerJSON(t, want))
		}
		if asked := api.count(func(c apiCall) bool { return c.verb == "review" }); asked > 4*n {
			t.Errorf("run %d: %d questions, more than one per kind and namespace (%d)", run, asked, 4*n)
		}
	}
}

// A grant's namespace rows are what the person's own reads of them give — read, refused or missing — and once its
// questions are answered, opening them again reads nothing.
func TestAGrantsNamespacesAreWhatItsOwnReadsGive(t *testing.T) {
	names := []string{"a", "b", "c"}
	scope := []string{"c", "a", "gone", "b"}
	review := func(user string, ra authorizationv1.ResourceAttributes) bool {
		return user == "u@example.com" && ra.Resource == "namespaces" && ra.Verb == "get" && ra.Namespace != "b"
	}
	ctx := grantCaller("u@example.com", scope...)
	reads := &clusterAPI{namespaces: names, review: review}
	rs, rb := reads.start(t)
	rb.inf, rb.cacheClient = nil, nil // no informers: the person's own reads
	want, err := rs.GetNamespaces(ctx)
	if err != nil {
		t.Fatal(err)
	}

	api := &clusterAPI{namespaces: names, review: review}
	s, _ := api.start(t, namespacesAsListed(append(names, "other")...)...)
	for open := 0; open < 2; open++ {
		before := len(api.callsOf("u@example.com"))
		got, err := s.GetNamespaces(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if answerJSON(t, got) != answerJSON(t, want) {
			t.Fatalf("open %d\n got %s\nwant %s", open, answerJSON(t, got), answerJSON(t, want))
		}
		calls := api.callsOf("u@example.com")[before:]
		if wantCalls := []int{len(scope), 0}[open]; len(calls) != wantCalls || (open == 0 && callsByKind(calls) != "review get namespaces=4") {
			t.Errorf("open %d: %d requests (%s), want %d questions and no read", open, len(calls), callsByKind(calls), wantCalls)
		}
	}
	if got := answerJSON(t, want); !strings.Contains(got, `"labels":{"kubernetes.io/metadata.name":"a"}`) || strings.Count(got, `"created_at":""`) != 2 {
		t.Errorf("the own reads gave %s, want a and c read, b refused and gone missing", got)
	}
}
