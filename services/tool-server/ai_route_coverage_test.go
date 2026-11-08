package main

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
)

// k8s-service's, auth-service's, session-service's and ai-service's tests hold every GET route to a row of this file. These hold each row to the tool: a tool
// that is registered, takes the arguments and reaches that route or that kind. A row with a note says how the tool answers
// the same facts another way: reads names what its call reaches there, and that is checked. That those facts are the same
// is the note's word.
const aiRouteCoverageFile = "../ai-service/tests/fixtures/ai_route_coverage.json"

type aiRouteCoverage struct {
	Tool     string                 `json:"tool"`
	Args     map[string]interface{} `json:"args"`
	Via      string                 `json:"via"`
	Note     string                 `json:"note"`
	Reads    string                 `json:"reads"`
	Excluded string                 `json:"excluded"`
}

func loadRouteCoverage(t *testing.T) map[string]map[string]aiRouteCoverage {
	t.Helper()
	raw, err := os.ReadFile(aiRouteCoverageFile)
	if err != nil {
		t.Fatal(err)
	}
	var table map[string]map[string]aiRouteCoverage
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatal(err)
	}
	return table
}

func coveredRoutes(t *testing.T) map[string]aiRouteCoverage {
	t.Helper()
	all := map[string]aiRouteCoverage{}
	for service, rows := range loadRouteCoverage(t) {
		for route, row := range rows {
			if row.Tool != "" {
				all[service+" "+route] = row
			}
		}
	}
	return all
}

func routePattern(route string) *regexp.Regexp {
	return regexp.MustCompile("^" + regexp.MustCompile(`\\\{[^}]+\\\}`).ReplaceAllString(regexp.QuoteMeta(route), `[^/]+`) + "$")
}

func TestRouteCoverage_EachToolIsRegisteredAndNotAWrite(t *testing.T) {
	registry := buildToolRegistry()
	for key, row := range coveredRoutes(t) {
		if _, ok := registry[row.Tool]; !ok {
			t.Errorf("%s: %s is not a tool", key, row.Tool)
		}
		if requiresApproval(row.Tool) || row.Tool == "alert_investigate" {
			t.Errorf("%s: %s changes something, and does not read a screen's data", key, row.Tool)
		}
	}
}

func TestRouteCoverage_EachRowTakesTheToolsArguments(t *testing.T) {
	for key, row := range coveredRoutes(t) {
		if err := validateToolArgs(row.Args); err != nil {
			t.Errorf("%s: %v", key, err)
		}
	}
}

func TestRouteCoverage_AViaRouteIsARouteOfTheTable(t *testing.T) {
	table := loadRouteCoverage(t)
	for service, rows := range table {
		for route, row := range rows {
			if row.Via == "" {
				continue
			}
			if via, ok := rows[row.Via]; !ok || via.Tool == "" {
				t.Errorf("%s %s goes through %s, which no tool reads in the table: %+v", service, route, row.Via, via)
			}
		}
	}
}

// What a note's call reads is a route some service has, unless it is a kubectl run.
func TestRouteCoverage_AReadsRouteIsARouteOfTheTable(t *testing.T) {
	table := loadRouteCoverage(t)
	for service, rows := range table {
		for route, row := range rows {
			if row.Reads == "" || strings.HasPrefix(row.Reads, "kubectl ") {
				continue
			}
			if !slices.ContainsFunc(slices.Collect(maps.Values(table)), func(other map[string]aiRouteCoverage) bool {
				_, ok := other[row.Reads]
				return ok
			}) {
				t.Errorf("%s %s reads %s, which is in no service's table", service, route, row.Reads)
			}
		}
	}
}

type coverageCalls struct {
	mu      sync.Mutex
	paths   []string
	kubectl [][]string
}

func (c *coverageCalls) addPath(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.paths = append(c.paths, path)
}

func (c *coverageCalls) addKubectl(args []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.kubectl = append(c.kubectl, args)
}

func (c *coverageCalls) reached(pattern *regexp.Regexp) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.ContainsFunc(c.paths, pattern.MatchString)
}

// ranKubectlOn: one kubectl run named the kind and, when the row gives one, the object.
func (c *coverageCalls) ranKubectlOn(kind, name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, args := range c.kubectl {
		if slices.Contains(args, kind) && (name == "" || slices.Contains(args, name)) {
			return true
		}
	}
	return false
}

// reads: a route of the stand-in, or the words of one kubectl run, in their order, after "kubectl ".
func (c *coverageCalls) reads(what string) bool {
	words, isKubectl := strings.CutPrefix(what, "kubectl ")
	if !isKubectl {
		return c.reached(routePattern(what))
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.ContainsFunc(c.kubectl, func(args []string) bool {
		rest := args
		for _, word := range strings.Fields(words) {
			at := slices.Index(rest, word)
			if at < 0 {
				return false
			}
			rest = rest[at+1:]
		}
		return true
	})
}

func TestRouteCoverage_ReadsMatchesOnlyWhatTheCallRan(t *testing.T) {
	calls := &coverageCalls{paths: []string{"/api/v1/namespaces/x/timeline/Deployment/y"}, kubectl: [][]string{{"get", "jobs", "-n", "x", "-o", "wide"}}}
	for what, want := range map[string]bool{
		"/api/v1/namespaces/{namespace}/timeline/{kind}/{name}": true,
		"/api/v1/namespaces/{namespace}/timeline":               false,
		"kubectl get jobs -n x":                                 true,
		"kubectl -n x get jobs":                                 false,
		"kubectl get pods":                                      false,
		"":                                                      false,
	} {
		if got := calls.reads(what); got != want {
			t.Errorf("reads(%q) = %v, want %v", what, got, want)
		}
	}
}

func (c *coverageCalls) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	raw, _ := json.Marshal(map[string]interface{}{"paths": c.paths, "kubectl": c.kubectl})
	return string(raw)
}

// callForCoverage runs the tool on answers of both shapes: a handler that expects a list stops at the wrong one before its next read.
func callForCoverage(t *testing.T, row aiRouteCoverage, handler ToolHandler) (*coverageCalls, error) {
	t.Helper()
	calls := &coverageCalls{}
	var answer string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.addPath(r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Kubeast-Total", "0")
		_, _ = w.Write([]byte(answer))
	}))
	defer srv.Close()
	origK8s, origAuth, origAI, origKubectl := k8sServiceURL, authServiceURL, aiServiceURL, kubectlExec
	k8sServiceURL, authServiceURL, aiServiceURL = srv.URL, srv.URL, srv.URL
	kubectlExec = func(_ context.Context, args []string, _ *string) ([]byte, error) {
		calls.addKubectl(args)
		return []byte(`{"items":[]}`), nil
	}
	defer func() {
		k8sServiceURL, authServiceURL, aiServiceURL, kubectlExec = origK8s, origAuth, origAI, origKubectl
	}()

	var firstErr error
	// The third is an alert window of this cluster with a finished investigation, which the next read opens.
	for _, shape := range []string{`{}`, `[]`, `{"cluster":"coverage","investigation":{"id":"y","status":"done"}}`} {
		answer = shape
		args := make(map[string]interface{}, len(row.Args))
		for k, v := range row.Args {
			args[k] = v
		}
		if _, err := handler(ctxFor("coverage"), args, bearer()); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return calls, firstErr
}

func TestRouteCoverage_EachToolReachesWhatItsRowSays(t *testing.T) {
	registry := buildToolRegistry()
	rows := coveredRoutes(t)
	keys := make([]string, 0, len(rows))
	for key := range rows {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		row := rows[key]
		t.Run(key, func(t *testing.T) {
			tool, ok := registry[row.Tool]
			if !ok {
				t.Fatalf("%s is not a tool", row.Tool)
			}
			calls, err := callForCoverage(t, row, tool.Handler)
			if errors.Is(err, errBadRequest) {
				t.Fatalf("%s refused the row's arguments: %v", row.Tool, err)
			}
			if row.Note != "" {
				if !calls.reads(row.Reads) {
					t.Errorf("%s did not read %q: %s", row.Tool, row.Reads, calls)
				}
				return
			}
			route := strings.SplitN(key, " ", 2)[1]
			if row.Via != "" {
				route = row.Via
			}
			if calls.reached(routePattern(route)) {
				return
			}
			kind, _ := row.Args["resource_type"].(string)
			name, _ := row.Args["resource_name"].(string)
			if row.Via == "" && kind != "" && calls.ranKubectlOn(kind, name) {
				return
			}
			t.Errorf("%s did not reach %s: %s", row.Tool, route, calls)
		})
	}
}

// The file is also read by people deciding whether a route may stay out: the words have to be a reason.
func TestRouteCoverage_EachRowIsAToolOrAReason(t *testing.T) {
	for service, rows := range loadRouteCoverage(t) {
		for route, row := range rows {
			switch {
			case (row.Tool == "") == (row.Excluded == ""):
				t.Errorf("%s %s: a tool or a reason, one of them: %+v", service, route, row)
			case row.Tool != "" && row.Via != "" && row.Note != "":
				t.Errorf("%s %s: via says the route it reads and a note says it reads another way, so one of them: %+v", service, route, row)
			case (row.Note == "") != (row.Reads == ""):
				t.Errorf("%s %s: a note and what its call reads, both of them: %+v", service, route, row)
			case row.Tool == "" && len(row.Excluded) < 40:
				t.Errorf("%s %s: %q does not say why", service, route, row.Excluded)
			}
		}
	}
}
