package k8s

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"

	discoveryv1 "k8s.io/api/discovery/v1"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/endpointslice"
)

// A Service drawer's "Backend Pod Resource Usage" sums the usage of the pods behind the Service's ready endpoints. The
// screen names them in one query (serviceBackend.ts podNamesPattern) while they fit the gateway's request line; past
// that it reads this sum, which names them in as many queries as it takes and adds the answers.

const (
	// backendPatternMax is the longest pod matcher, written into the query's URL, that one query to Prometheus carries:
	// a store behind nginx takes a request line of 8 KiB, and the rest of the query and the address take less than the
	// remainder (the screen's POD_PATTERN_URL_MAX).
	backendPatternMax = 6000
	// backendQueriesMax bounds the queries of one sum (three per matcher): past it the answer says so instead of a sum.
	backendQueriesMax = 60
	// backendQueryPlaces bound the queries of one sum running at once.
	backendQueryPlaces = 4
)

// BackendUsage is what the drawer's three cards show for the pods behind a Service. A sum Prometheus had no series for
// is nil, which the drawer leaves out as it does for one query's empty answer.
type BackendUsage struct {
	Available bool `json:"available"`
	// Pods counts the pods of the Service's ready endpoints.
	Pods int `json:"pods"`
	// Queries is how many queries the pods take; PastQueries says that is more than backendQueriesMax, and none was asked.
	Queries     int  `json:"queries"`
	PastQueries bool `json:"past_queries,omitempty"`
	// CPU in millicores, memory as the working set in bytes, PodCount the pods Prometheus has CPU series of.
	CPU      *float64 `json:"cpu_millicores"`
	Memory   *float64 `json:"memory_bytes"`
	PodCount *float64 `json:"pod_count"`
}

// ServiceBackendPods lists the pods of a Service's ready endpoints, each once and sorted, as the drawer reads them from
// the describe answer (backendPodNames): an endpoint naming a Pod of another namespace is not summed with this one's.
func (s *Service) ServiceBackendPods(ctx context.Context, namespace, name string) ([]string, error) {
	slices, err := s.serviceEndpointSlices(ctx, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("list endpointslices of %s/%s: %w", namespace, name, err)
	}
	return backendPodsOf(slices, namespace), nil
}

// backendPodsOf is ServiceBackendPods over the Service's slices.
func backendPodsOf(slices []discoveryv1.EndpointSlice, namespace string) []string {
	seen := map[string]bool{}
	for i := range slices {
		for _, e := range slices[i].Endpoints {
			ref := e.TargetRef
			if !endpointslice.Ready(e) || len(e.Addresses) == 0 || ref == nil || ref.Kind != "Pod" || ref.Name == "" {
				continue
			}
			if ref.Namespace != "" && ref.Namespace != namespace {
				continue
			}
			seen[ref.Name] = true
		}
	}
	pods := make([]string, 0, len(seen))
	for pod := range seen {
		pods = append(pods, pod)
	}
	sort.Strings(pods)
	return pods
}

// backendPodPatterns cuts names into PromQL regular expressions, each matching its names and no other (Prometheus
// anchors them) and at most max long as the query's URL writes it. As the screen's podNamesPattern, the names that share
// the part before their last "-" (a workload's pods) are written once with their ends grouped; a group past max goes on
// in the next pattern.
func backendPodPatterns(names []string, max int) []string {
	// a regular expression's metacharacters escaped, in a PromQL string, where a backslash is written twice
	esc := func(s string) string { return strings.ReplaceAll(regexp.QuoteMeta(s), `\`, `\\`) }
	size := func(s string) int { return len(url.QueryEscape(s)) }
	type group struct {
		head  string
		tails []string
	}
	unique := map[string]bool{}
	for _, n := range names {
		unique[n] = true
	}
	sorted := make([]string, 0, len(unique))
	for n := range unique {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	var groups []group
	for _, n := range sorted {
		head, tail := "", n
		if cut := strings.LastIndex(n, "-"); cut > 0 {
			head, tail = n[:cut+1], n[cut+1:]
		}
		if len(groups) > 0 && groups[len(groups)-1].head == head {
			groups[len(groups)-1].tails = append(groups[len(groups)-1].tails, tail)
		} else {
			groups = append(groups, group{head: head, tails: []string{tail}})
		}
	}
	write := func(gs []group) string {
		parts := make([]string, 0, len(gs))
		for _, g := range gs {
			if len(g.tails) == 1 {
				parts = append(parts, esc(g.head+g.tails[0]))
				continue
			}
			tails := make([]string, len(g.tails))
			for i, t := range g.tails {
				tails[i] = esc(t)
			}
			parts = append(parts, esc(g.head)+"("+strings.Join(tails, "|")+")")
		}
		return strings.Join(parts, "|")
	}
	// The size adds up part by part, as both escapes write each character on its own: a name added to the last group
	// costs a "|" and its end, the second one the brackets too; a name of another head a "|", its head and its end.
	open, closing, bar := size("("), size(")"), size("|")
	var patterns []string
	var current []group
	used := 0
	for _, g := range groups {
		headSize := size(esc(g.head))
		for _, tail := range g.tails {
			tailSize := size(esc(tail))
			last := len(current) - 1
			sameHead := last >= 0 && current[last].head == g.head
			add := headSize + tailSize
			switch {
			case sameHead && len(current[last].tails) == 1:
				add = open + closing + bar + tailSize
			case sameHead:
				add = bar + tailSize
			case last >= 0:
				add = bar + headSize + tailSize
			}
			if last >= 0 && used+add > max {
				patterns = append(patterns, write(current))
				current, used, sameHead, add = nil, 0, false, headSize+tailSize
			}
			if sameHead {
				current[last].tails = append(current[last].tails, tail)
			} else {
				current = append(current, group{head: g.head, tails: []string{tail}})
			}
			used += add
		}
	}
	if len(current) > 0 {
		patterns = append(patterns, write(current))
	}
	return patterns
}

// backendQueries are the drawer's three queries for one pod matcher.
func backendQueries(namespace, pattern string) map[string]string {
	sel := fmt.Sprintf(`{namespace="%s",pod=~"%s",container!="",container!="POD"}`, namespace, pattern)
	return map[string]string{
		"cpu":       `sum(rate(container_cpu_usage_seconds_total` + sel + `[5m])) * 1000`,
		"memory":    `sum(container_memory_working_set_bytes` + sel + `)`,
		"pod_count": `count(count by(pod)(container_cpu_usage_seconds_total` + sel + `))`,
	}
}

// SumBackendUsage asks query for the usage of pods in namespace, the drawer's three queries for each pod matcher, and
// adds the answers up: the matchers name disjoint pods, so the CPU, the working set and the count of pods with series
// add. A namespace that is not a Kubernetes name is a bad input, never written into a query.
func SumBackendUsage(ctx context.Context, namespace string, pods []string, query func(context.Context, string) ([]PrometheusQueryResult, error)) (BackendUsage, error) {
	if errs := validation.IsDNS1123Label(namespace); len(errs) > 0 {
		return BackendUsage{}, badInput("namespace %q: %s", namespace, strings.Join(errs, "; "))
	}
	usage := BackendUsage{Available: true, Pods: len(pods)}
	if len(pods) == 0 {
		return usage, nil
	}
	patterns := backendPodPatterns(pods, backendPatternMax)
	usage.Queries = 3 * len(patterns)
	if usage.Queries > backendQueriesMax {
		usage.PastQueries = true
		return usage, nil
	}
	var (
		mu    sync.Mutex
		first error
		sums  = map[string]*float64{}
		wg    sync.WaitGroup
	)
	places := make(chan struct{}, backendQueryPlaces)
	for _, pattern := range patterns {
		for name, q := range backendQueries(namespace, pattern) {
			wg.Add(1)
			go func() {
				defer wg.Done()
				select {
				case places <- struct{}{}:
				case <-ctx.Done():
					mu.Lock()
					if first == nil {
						first = ctx.Err()
					}
					mu.Unlock()
					return
				}
				defer func() { <-places }()
				rows, err := query(ctx, q)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					if first == nil {
						first = err
					}
					return
				}
				for _, row := range rows {
					v := row.Value
					if sums[name] != nil {
						v += *sums[name]
					}
					sums[name] = &v
				}
			}()
		}
	}
	wg.Wait()
	if first != nil {
		return BackendUsage{}, first
	}
	usage.CPU, usage.Memory, usage.PodCount = sums["cpu"], sums["memory"], sums["pod_count"]
	return usage, nil
}
