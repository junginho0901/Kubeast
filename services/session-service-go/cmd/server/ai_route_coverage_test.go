package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strconv"
	"testing"
)

// What a screen reads, the AI reads too: every GET here names the tool that reads the same data or why none does. tool-server's
// test holds each tool to its row; ai-service's holds the model able to call it.
const aiRouteCoverageFile = "../../../ai-service/tests/fixtures/ai_route_coverage.json"

const shortestReason = 40

type aiRouteCoverage struct {
	Tool     string `json:"tool"`
	Excluded string `json:"excluded"`
}

// onRouter is r.Get or r.With(...).Get: a request's r.Header.Get or url's q.Get is not a route.
func onRouter(selector *ast.SelectorExpr) bool {
	switch x := selector.X.(type) {
	case *ast.Ident:
		return x.Name == "r"
	case *ast.CallExpr:
		with, ok := x.Fun.(*ast.SelectorExpr)
		return ok && with.Sel.Name == "With" && onRouter(with)
	}
	return false
}

// sessionServiceGETRoutes reads main, which builds the router in line with what only a running service has.
func sessionServiceGETRoutes(t *testing.T) map[string]bool {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	var walk func(node ast.Node, prefix string)
	walk = func(node ast.Node, prefix string) {
		ast.Inspect(node, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || !onRouter(selector) {
				return true
			}
			lit, ok := call.Args[0].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			path, err := strconv.Unquote(lit.Value)
			if err != nil {
				return true
			}
			switch selector.Sel.Name {
			case "Route":
				walk(call.Args[1], prefix+path)
				return false
			case "Get":
				got[prefix+path] = true
			}
			return true
		})
	}
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Name.Name == "main" {
			walk(fn.Body, "")
		}
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
	rows := table["session-service"]
	routes := sessionServiceGETRoutes(t)
	if len(routes) < 6 {
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
