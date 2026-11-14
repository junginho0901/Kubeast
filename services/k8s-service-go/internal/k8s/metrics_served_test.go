package k8s

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"

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

// ageDiscovery makes the cluster's last discovery read a minute older, as if apiResourcesTTL had passed.
func ageDiscovery(s *Service) {
	s.apiResourcesMu.Lock()
	defer s.apiResourcesMu.Unlock()
	for cid := range s.apiResourcesRead {
		s.apiResourcesRead[cid] = s.apiResourcesRead[cid].Add(-apiResourcesTTL)
		s.apiResourcesAt[cid] = s.apiResourcesAt[cid].Add(-apiResourcesTTL)
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

// A cluster whose discovery does not list metrics.k8s.io (no metrics-server) is not served for every caller, whichever
// asks first: a caller the cluster would refuse those lists gets the same answer as the admin, the 404 in the words the
// cluster gives the admin, and no list is asked of the cluster. Discovery is read once for all within its minute; past
// it, once for a crowd, and a metrics-server installed since answers from then on.
func TestAClusterWhoseDiscoveryListsNoMetricsAPIIsNotServedForEveryCallerWithoutAsking(t *testing.T) {
	const notFound = "the server could not find the requested resource"
	scope := []string{"web", "shop"}
	wantAdminTop := map[string]interface{}{"top_pods": []map[string]interface{}{}, "top_nodes": []map[string]interface{}{}, "pod_metrics_error": notFound, "node_metrics_error": notFound}
	// each namespace's pods not served is a namespace with nothing to read, as eachCallerNamespace takes a 404
	wantLimitedTop := map[string]interface{}{"top_pods": []map[string]interface{}{}, "top_nodes": []map[string]interface{}{}, "node_metrics_error": notFound}
	orders := map[string][]string{
		"the limited grant first": {"limited", "admin", "limited", "admin"},
		"the admin first":         {"admin", "limited", "admin", "limited"},
	}
	for name, order := range orders {
		t.Run(name, func(t *testing.T) {
			api := &metricsAPI{discovery: true, refusedUser: limitedUser}
			api.notServed.Store(true)
			s := api.service(t)
			for i, who := range order {
				ctx, wantTop := asAdmin(), wantAdminTop
				if who == "limited" {
					ctx, wantTop = asLimited(scope), wantLimitedTop
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
			if lists, discovery := api.reads(); lists != 0 || discovery != 1 {
				t.Fatalf("%d metrics lists and %d discovery reads, want none and one", lists, discovery)
			}
		})
	}

	// the words are the cluster's own 404 to a caller it lets list them
	asked := &metricsAPI{}
	asked.notServed.Store(true)
	if got, _ := asked.service(t).GetTopResources(asAdmin(), 5, 3, TopSkip{}); !reflect.DeepEqual(got, wantAdminTop) {
		t.Fatalf("the cluster asked answers %v, discovery %v", got, wantAdminTop)
	}

	api := &metricsAPI{discovery: true, refusedUser: limitedUser, pods: map[string][]string{"web": {`{"metadata":{"name":"web","namespace":"web"},"containers":[{"name":"c","usage":{"cpu":"5m","memory":"10Mi"}}],"timestamp":"t"}`}}}
	api.notServed.Store(true)
	s := api.service(t)
	_, _ = s.GetTopResources(asAdmin(), 5, 3, TopSkip{})
	// past the minute a crowd reads discovery once
	ageDiscovery(s)
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
	if lists, discovery := api.reads(); lists != 0 || discovery != 2 {
		t.Fatalf("past the minute: %d metrics lists and %d discovery reads, want none and two in all", lists, discovery)
	}

	// metrics-server installed: once discovery is read again, each caller's own answer
	api.notServed.Store(false)
	ageDiscovery(s)
	served, _ := s.GetTopResources(asAdmin(), 5, 3, TopSkip{})
	if pods, _ := served["top_pods"].([]map[string]interface{}); len(pods) != 1 || served["pod_metrics_error"] != nil || served["node_metrics_error"] != nil {
		t.Fatalf("answer once served: %v", served)
	}
	if _, err := s.GetNodeMetrics(asLimited(scope)); !apierrors.IsForbidden(err) {
		t.Fatalf("the limited grant once served: %v, want its refusal", err)
	}
	if lists, discovery := api.reads(); lists != 3 || discovery != 3 {
		t.Errorf("once served: %d metrics lists and %d discovery reads, want the pods', the nodes' and the refused nodes', and one more read", lists, discovery)
	}
}

// On a cluster that serves metrics.k8s.io the caller's own answer stands every time, whoever asked before: the limited
// grant gets its 403 in the cluster's words, the admin its rows, and nothing of either is kept for the other.
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
			api := &metricsAPI{discovery: true, refusedUser: limitedUser, pods: map[string][]string{"web": {`{"metadata":{"name":"web","namespace":"web"},"containers":[{"name":"c","usage":{"cpu":"5m","memory":"10Mi"}}],"timestamp":"t"}`}}}
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

// metrics-server registered but not running: discovery names metrics.k8s.io as not answering, which is served, so
// each caller's own read decides (the aggregator's 503 for the admin, the refusal for the limited grant), not "not
// served". That partial read stands for the metrics question its whole minute, as a full one does.
func TestAMetricsServerThatDoesNotAnswerIsAskedByEachCaller(t *testing.T) {
	api := &metricsAPI{discovery: true, refusedUser: limitedUser, down: true}
	s := api.service(t)
	for range 3 {
		_, err := s.GetNodeMetrics(asAdmin())
		if !apierrors.IsServiceUnavailable(err) || errors.Is(err, ErrMetricsNotServed) {
			t.Fatalf("admin: %v, want the aggregator's 503", err)
		}
		if _, err := s.GetNodeMetrics(asLimited([]string{"web"})); !apierrors.IsForbidden(err) {
			t.Fatalf("limited: %v, want its refusal", err)
		}
	}
	// one discovery read, whose group list client-go asks twice when a group does not answer (withRetries)
	if lists, discovery := api.reads(); lists != 6 || discovery != 2 {
		t.Fatalf("%d metrics lists and %d group lists asked, want six and two", lists, discovery)
	}
}

// Without a discovery to read (it failed, or the client has none) every caller asks for itself, as before the check.
func TestMetricsReadWithoutDiscoveryAsksTheCluster(t *testing.T) {
	api := &metricsAPI{refusedUser: limitedUser}
	api.notServed.Store(true)
	s := api.service(t)
	if _, err := s.GetNodeMetrics(asAdmin()); !errors.Is(err, ErrMetricsNotServed) {
		t.Fatalf("admin: %v", err)
	}
	if _, err := s.GetNodeMetrics(asLimited([]string{"web"})); !apierrors.IsForbidden(err) {
		t.Fatalf("limited: %v, want its own refusal", err)
	}
	if lists, _ := api.reads(); lists != 2 {
		t.Fatalf("%d metrics lists, want each caller's", lists)
	}
}
