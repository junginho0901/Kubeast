package routes

import (
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"sort"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
)

// What a screen reads, the AI reads too: every GET here names the tool that reads the same data or why none does. tool-server's
// test holds each tool to its row; ai-service's holds the model able to call it.
const aiRouteCoverageFile = "../../../ai-service/tests/fixtures/ai_route_coverage.json"

const shortestReason = 40

type aiRouteCoverage struct {
	Tool     string `json:"tool"`
	Excluded string `json:"excluded"`
}

// main.go registers the routes that do not take the cluster middleware itself.
var mainGoRoute = regexp.MustCompile(`\br\.Get\("([^"]+)"`)

func k8sServiceGETRoutes(t *testing.T) map[string]bool {
	t.Helper()
	r := chi.NewRouter()
	Register(r, &handler.Handler{}, ws.NewMultiplexer(nil))
	got := map[string]bool{}
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method == http.MethodGet {
			got[route] = true
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile("../../cmd/server/main.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, match := range mainGoRoute.FindAllSubmatch(source, -1) {
		got[string(match[1])] = true
	}
	return got
}

func TestEveryGETRouteIsReadByAToolOrExcludedWithAReason(t *testing.T) {
	raw, err := os.ReadFile(aiRouteCoverageFile)
	if err != nil {
		t.Fatal(err)
	}
	var table map[string]map[string]aiRouteCoverage
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatal(err)
	}
	rows := table["k8s-service"]
	routes := k8sServiceGETRoutes(t)
	if len(routes) < 280 {
		t.Fatalf("only %d GET routes were found: the walk lost some", len(routes))
	}
	names := make([]string, 0, len(routes))
	for route := range routes {
		names = append(names, route)
	}
	sort.Strings(names)
	for _, route := range names {
		row, listed := rows[route]
		switch {
		case !listed:
			t.Errorf("GET %s: no tool reads it and no reason says why not; add it to %s", route, aiRouteCoverageFile)
		case (row.Tool == "") == (row.Excluded == ""):
			t.Errorf("GET %s: its row needs a tool or a reason, one of them: %+v", route, row)
		case row.Tool == "" && len(row.Excluded) < shortestReason:
			t.Errorf("GET %s: %q does not say why", route, row.Excluded)
		}
	}
	for route := range rows {
		if !routes[route] {
			t.Errorf("GET %s is in %s and not on the router", route, aiRouteCoverageFile)
		}
	}
}
