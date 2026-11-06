package main

import (
	"context"
	"encoding/json"
	"errors"
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

// k8s-service's and auth-service's tests hold every GET route to a row of this file. These hold each row to the tool: a tool
// that is registered, takes the arguments and reaches that route or that kind. A row with a note says how the tool answers
// the same facts another way, so only its call is checked.
const aiRouteCoverageFile = "../ai-service/tests/fixtures/ai_route_coverage.json"

type aiRouteCoverage struct {
	Tool     string                 `json:"tool"`
	Args     map[string]interface{} `json:"args"`
	Via      string                 `json:"via"`
	Note     string                 `json:"note"`
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
	origK8s, origAuth, origKubectl := k8sServiceURL, authServiceURL, kubectlExec
	k8sServiceURL, authServiceURL = srv.URL, srv.URL
	kubectlExec = func(_ context.Context, args []string, _ *string) ([]byte, error) {
		calls.addKubectl(args)
		return []byte(`{"items":[]}`), nil
	}
	defer func() { k8sServiceURL, authServiceURL, kubectlExec = origK8s, origAuth, origKubectl }()

	var firstErr error
	for _, shape := range []string{`{}`, `[]`} {
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
				t.Errorf("%s %s: via is checked and a note is not, so one of them: %+v", service, route, row)
			case row.Tool == "" && len(row.Excluded) < 40:
				t.Errorf("%s %s: %q does not say why", service, route, row.Excluded)
			}
		}
	}
}
