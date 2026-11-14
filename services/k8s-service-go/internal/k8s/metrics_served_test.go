package k8s

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The two callers of these tests on the stand-in's default cluster: a global admin, and a Read grant limited to
// namespaces whose identity the cluster refuses the metrics.k8s.io lists (metricsAPI.refusedUser).
const limitedUser = "nsread"

func asAdmin() context.Context {
	return auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "admin", Perms: auth.PermissionMatrix{"*": {"*"}}})
}

func asLimited(namespaces []string) context.Context {
	return auth.WithPayload(context.Background(), auth.TokenPayload{UserID: limitedUser, Namespaces: map[string][]string{"default": namespaces}})
}

// aMinuteLater makes the cluster's last discovery read and its metrics.k8s.io answer a minute older, as if
// apiResourcesTTL and metricsVerdictTTL had passed.
func aMinuteLater(s *Service) {
	s.apiResourcesMu.Lock()
	for cid := range s.apiResourcesRead {
		s.apiResourcesRead[cid] = s.apiResourcesRead[cid].Add(-apiResourcesTTL)
		s.apiResourcesAt[cid] = s.apiResourcesAt[cid].Add(-apiResourcesTTL)
	}
	s.apiResourcesMu.Unlock()
	b := s.defaultBundle.Load()
	if v := b.metricsServed.Load(); v != nil {
		b.metricsServed.Store(&metricsVerdict{serving: v.serving, at: v.at.Add(-metricsVerdictTTL)})
	}
}

func (a *metricsAPI) reads() (lists, discovery int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.asked), a.discoveryReads
}

// metricsAnswers is what a caller gets from top-resources and Monitoring's node and pod reads.
type metricsAnswers struct {
	top      map[string]interface{}
	nodes    error
	podsAll  error
	podsInNs error
}

func readMetricsAs(t *testing.T, s *Service, ctx context.Context, namespace string) metricsAnswers {
	t.Helper()
	top, err := s.GetTopResources(ctx, 5, 3, TopSkip{})
	if err != nil {
		t.Fatal(err)
	}
	_, nodesErr := s.GetNodeMetrics(ctx)
	_, podsAllErr := s.GetPodMetrics(ctx, "")
	_, podsInNsErr := s.GetPodMetrics(ctx, namespace)
	return metricsAnswers{top, nodesErr, podsAllErr, podsInNsErr}
}

const webPod = `{"metadata":{"name":"web","namespace":"web"},"containers":[{"name":"c","usage":{"cpu":"5m","memory":"10Mi"}}],"timestamp":"t"}`

// On a cluster that answers the metrics lists no discovery is read, however many reads and minutes go by: the lists
// are asked first, and only a 404 or a 403 asks whether the group is served.
func TestMetricsReadsOfAClusterThatAnswersThemReadNoDiscovery(t *testing.T) {
	api := &metricsAPI{discovery: true, pods: map[string][]string{"web": {webPod}}}
	s := api.service(t)
	const minutes, readsAMinute = 3, 12
	for range minutes {
		for range readsAMinute {
			got := readMetricsAs(t, s, asAdmin(), "web")
			if pods, _ := got.top["top_pods"].([]map[string]interface{}); len(pods) != 1 || got.nodes != nil || got.podsAll != nil || got.podsInNs != nil {
				t.Fatalf("answer: %v, nodes %v, pods %v and %v", got.top, got.nodes, got.podsAll, got.podsInNs)
			}
		}
		aMinuteLater(s)
	}
	if lists, discovery := api.reads(); lists != minutes*readsAMinute*5 || discovery != 0 {
		t.Fatalf("%d metrics lists and %d discovery reads, want %d and none", lists, discovery, minutes*readsAMinute*5)
	}
}

// A cluster whose discovery does not list metrics.k8s.io (no metrics-server) is not served for every caller, whichever
// asks first: a caller the cluster would refuse those lists gets the same answer as the admin, the 404 in the words the
// cluster gives the admin, the pods part of top-resources too. The first caller's list(s) find it and discovery is read
// once; for the rest of the minute no list is asked and discovery is not read. Past the minute discovery is read once
// for a crowd, and a metrics-server installed since answers from then on.
func TestAClusterWhoseDiscoveryListsNoMetricsAPIIsNotServedForEveryCaller(t *testing.T) {
	const notFound = "the server could not find the requested resource"
	scope := []string{"web", "shop"}
	wantTop := map[string]interface{}{"top_pods": []map[string]interface{}{}, "top_nodes": []map[string]interface{}{}, "pod_metrics_error": notFound, "node_metrics_error": notFound}
	orders := map[string]struct {
		order    []string
		maxLists int
	}{
		// the two namespaces' lists go side by side, so the second may start before the first's answer is known
		"the limited grant first": {[]string{"limited", "admin", "limited", "admin"}, 2},
		"the admin first":         {[]string{"admin", "limited", "admin", "limited"}, 1},
	}
	for name, c := range orders {
		t.Run(name, func(t *testing.T) {
			api := &metricsAPI{discovery: true, refusedUser: limitedUser}
			api.notServed.Store(true)
			s := api.service(t)
			for i, who := range c.order {
				ctx := asAdmin()
				if who == "limited" {
					ctx = asLimited(scope)
				}
				got := readMetricsAs(t, s, ctx, "web")
				if !reflect.DeepEqual(got.top, wantTop) {
					t.Errorf("%d %s: top resources %v, want %v", i, who, got.top, wantTop)
				}
				for read, err := range map[string]error{"nodes": got.nodes, "pods of every namespace": got.podsAll, "pods of one namespace": got.podsInNs} {
					if !errors.Is(err, ErrMetricsNotServed) || err.Error() != notFound || apierrors.IsForbidden(err) {
						t.Errorf("%d %s: %s answered %v, want not served", i, who, read, err)
					}
				}
			}
			if lists, discovery := api.reads(); lists < 1 || lists > c.maxLists || discovery != 1 {
				t.Fatalf("%d metrics lists and %d discovery reads, want the first caller's (at most %d) and one", lists, discovery, c.maxLists)
			}
		})
	}

	// the words are the cluster's own 404 to a caller it lets list them
	asked := &metricsAPI{}
	asked.notServed.Store(true)
	if got, _ := asked.service(t).GetTopResources(asAdmin(), 5, 3, TopSkip{}); !reflect.DeepEqual(got, wantTop) {
		t.Fatalf("the cluster asked answers %v, discovery %v", got, wantTop)
	}

	api := &metricsAPI{discovery: true, refusedUser: limitedUser, pods: map[string][]string{"web": {webPod}}}
	api.notServed.Store(true)
	s := api.service(t)
	_, _ = s.GetTopResources(asAdmin(), 5, 3, TopSkip{})
	for range 30 {
		_, _ = s.GetNodeMetrics(asLimited(scope))
	}
	if lists, discovery := api.reads(); lists != 1 || discovery != 1 {
		t.Fatalf("within the minute: %d metrics lists and %d discovery reads, want the first pods list and one", lists, discovery)
	}
	// past the minute a crowd reads discovery once, and asks no list
	aMinuteLater(s)
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx := asAdmin()
			if i%2 == 1 {
				ctx = asLimited(scope)
			}
			if _, err := s.GetNodeMetrics(ctx); !errors.Is(err, ErrMetricsNotServed) {
				t.Errorf("past the minute: %v", err)
			}
		}()
	}
	wg.Wait()
	if lists, discovery := api.reads(); lists != 1 || discovery != 2 {
		t.Fatalf("past the minute: %d metrics lists and %d discovery reads, want one and two in all", lists, discovery)
	}

	// metrics-server installed: once its minute is over, each caller's own answer
	api.notServed.Store(false)
	aMinuteLater(s)
	served, _ := s.GetTopResources(asAdmin(), 5, 3, TopSkip{})
	if pods, _ := served["top_pods"].([]map[string]interface{}); len(pods) != 1 || served["pod_metrics_error"] != nil || served["node_metrics_error"] != nil {
		t.Fatalf("answer once served: %v", served)
	}
	if _, err := s.GetNodeMetrics(asLimited(scope)); !apierrors.IsForbidden(err) {
		t.Fatalf("the limited grant once served: %v, want its refusal", err)
	}
	if lists, discovery := api.reads(); lists != 4 || discovery != 3 {
		t.Errorf("once served: %d metrics lists and %d discovery reads, want three more lists (pods, nodes, the refused nodes) and one more read", lists, discovery)
	}
}

// A discovery read within the minute, by another route, answers without a read of its own.
func TestMetricsNotServedTakesTheDiscoveryReadWithinTheMinute(t *testing.T) {
	api := &metricsAPI{discovery: true, refusedUser: limitedUser}
	api.notServed.Store(true)
	s := api.service(t)
	if _, err := s.GetAPIResources(asAdmin()); err != nil {
		t.Fatal(err)
	}
	for _, ctx := range []context.Context{asLimited([]string{"web"}), asAdmin()} {
		if _, err := s.GetNodeMetrics(ctx); !errors.Is(err, ErrMetricsNotServed) {
			t.Fatalf("%v, want not served", err)
		}
	}
	if lists, discovery := api.reads(); lists != 1 || discovery != 1 {
		t.Fatalf("%d metrics lists and %d discovery reads, want the first caller's and the other route's", lists, discovery)
	}
}

// On a cluster that serves metrics.k8s.io the caller's own answer stands every time, whoever asked before: the limited
// grant gets its 403 in the cluster's words, the admin its rows, and nothing of either is kept for the other. The first
// refusal reads the group's discovery once for the minute; the admin's reads read none.
func TestOnAClusterServingTheMetricsAPIEachCallerGetsItsOwnAnswerWhateverTheOrder(t *testing.T) {
	scope := []string{"web", "shop"}
	nodesRefusal := `nodes.metrics.k8s.io is forbidden: User "u1" cannot list resource "nodes" in API group "metrics.k8s.io" at the cluster scope`
	podsRefusal := `pods.metrics.k8s.io is forbidden: User "u1" cannot list resource "pods" in API group "metrics.k8s.io" in the namespace "web"`
	wantLimitedTop := map[string]interface{}{
		"top_pods": []map[string]interface{}{}, "pod_metrics_error": `pods.metrics.k8s.io is forbidden: User "u1" cannot list resource "pods" in API group "metrics.k8s.io" in the namespace "shop"`, "pod_metrics_refused": true,
		"top_nodes": []map[string]interface{}{}, "node_metrics_error": nodesRefusal, "node_metrics_refused": true,
	}
	orders := map[string][]string{
		"the limited grant first": {"limited", "admin", "limited", "admin", "limited"},
		"the admin first":         {"admin", "limited", "admin", "limited"},
	}
	for name, order := range orders {
		t.Run(name, func(t *testing.T) {
			api := &metricsAPI{discovery: true, refusedUser: limitedUser, pods: map[string][]string{"web": {webPod}}}
			s := api.service(t)
			lists := 0
			for i, who := range order {
				if who == "admin" {
					got := readMetricsAs(t, s, asAdmin(), "web")
					if pods, _ := got.top["top_pods"].([]map[string]interface{}); len(pods) != 1 || got.top["node_metrics_error"] != nil || got.nodes != nil || got.podsAll != nil || got.podsInNs != nil {
						t.Errorf("%d admin: %v, nodes %v, pods %v and %v", i, got.top, got.nodes, got.podsAll, got.podsInNs)
					}
					lists += 5 // top pods and nodes, nodes, every namespace's pods, one namespace's
					continue
				}
				got := readMetricsAs(t, s, asLimited(scope), "web")
				if !reflect.DeepEqual(got.top, wantLimitedTop) {
					t.Errorf("%d limited: top resources %v, want %v", i, got.top, wantLimitedTop)
				}
				for read, c := range map[string]struct {
					err  error
					want string
				}{"nodes": {got.nodes, nodesRefusal}, "pods of every namespace": {got.podsAll, podsRefusal}, "pods of one namespace": {got.podsInNs, podsRefusal}} {
					if !apierrors.IsForbidden(c.err) || c.err.Error() != c.want || errors.Is(c.err, ErrMetricsNotServed) {
						t.Errorf("%d limited: %s answered %v, want the refusal %q", i, read, c.err, c.want)
					}
				}
				lists += 3 + 1 + 2 + 1 // top: two namespaces and the nodes; nodes; every namespace = its two; one namespace
			}
			if got, discovery := api.reads(); got != lists || discovery != 1 {
				t.Fatalf("%d metrics lists and %d discovery reads, want %d (each read asks) and one", got, discovery, lists)
			}
		})
	}
}

// metrics-server registered but not running: the group's discovery document is served (kube-aggregator answers it from
// the APIService), and a discovery read names metrics.k8s.io as not answering, which is served too. Each caller's own
// read decides (the aggregator's 503 for the admin, the refusal for the limited grant), not "not served", and the 503
// reads no discovery.
func TestAMetricsServerThatDoesNotAnswerIsAskedByEachCaller(t *testing.T) {
	for _, readFirst := range []bool{false, true} {
		api := &metricsAPI{discovery: true, refusedUser: limitedUser, down: true}
		s := api.service(t)
		wantDiscovery := 1 // the group's document, read for the first refusal
		if readFirst {
			// a discovery read by another route, whose group list client-go asks twice when a group does not answer
			// (withRetries); it stands for the metrics question
			_, _ = s.GetAPIResources(asAdmin())
			wantDiscovery = 2
		}
		for range 3 {
			_, err := s.GetNodeMetrics(asAdmin())
			if !apierrors.IsServiceUnavailable(err) || errors.Is(err, ErrMetricsNotServed) {
				t.Fatalf("admin: %v, want the aggregator's 503", err)
			}
			if _, err := s.GetNodeMetrics(asLimited([]string{"web"})); !apierrors.IsForbidden(err) {
				t.Fatalf("limited: %v, want its refusal", err)
			}
		}
		if lists, discovery := api.reads(); lists != 6 || discovery != wantDiscovery {
			t.Fatalf("discovery read first %v: %d metrics lists and %d discovery reads, want six and %d", readFirst, lists, discovery, wantDiscovery)
		}
	}
}

// While discovery cannot be read every caller gets its own answer, as before the check: the admin the cluster's 404, the
// limited grant its refusal. The failure stands for the minute like an answer, so discovery is read once a minute,
// not on each metrics read.
func TestWhileDiscoveryFailsEachCallerGetsItsOwnAnswerAndDiscoveryIsReadOnceAMinute(t *testing.T) {
	api := &metricsAPI{refusedUser: limitedUser, discoveryFails: true}
	api.notServed.Store(true)
	s := api.service(t)
	const minutes, readsAMinute = 3, 10
	for m := range minutes {
		for range readsAMinute {
			if _, err := s.GetNodeMetrics(asAdmin()); !errors.Is(err, ErrMetricsNotServed) {
				t.Fatalf("admin: %v", err)
			}
			if _, err := s.GetNodeMetrics(asLimited([]string{"web"})); !apierrors.IsForbidden(err) {
				t.Fatalf("limited: %v, want its own refusal", err)
			}
		}
		if lists, discovery := api.reads(); lists != (m+1)*readsAMinute*2 || discovery != m+1 {
			t.Fatalf("minute %d: %d metrics lists and %d discovery reads, want each caller's and %d", m+1, lists, discovery, m+1)
		}
		aMinuteLater(s)
	}
}

// A discovery that does not answer keeps no caller past metricsGroupReadTimeout: the caller gets its own answer, and
// the minute goes by without another read.
func TestADiscoveryThatDoesNotAnswerKeepsNoCallerWaiting(t *testing.T) {
	timeout := metricsGroupReadTimeout
	metricsGroupReadTimeout = 50 * time.Millisecond
	t.Cleanup(func() { metricsGroupReadTimeout = timeout })
	api := &metricsAPI{refusedUser: limitedUser, discoveryDelay: time.Second}
	s := api.service(t)
	start := time.Now()
	if _, err := s.GetNodeMetrics(asLimited([]string{"web"})); !apierrors.IsForbidden(err) {
		t.Fatalf("limited: %v, want its own refusal", err)
	}
	if took := time.Since(start); took > 500*time.Millisecond {
		t.Fatalf("the read took %v with discovery not answering", took)
	}
	if _, err := s.GetNodeMetrics(asLimited([]string{"web"})); !apierrors.IsForbidden(err) {
		t.Fatalf("limited again: %v", err)
	}
	if _, discovery := api.reads(); discovery != 1 {
		t.Fatalf("%d discovery reads, want one for the minute", discovery)
	}
}
