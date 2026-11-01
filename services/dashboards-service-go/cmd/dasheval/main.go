// Command dasheval grades dashboards an AI builder wrote for the requests in
// evals/dashboards (see its README). Without -answers it grades each case's
// reference answer; with -prometheus every query also runs there.
//
//	go run ./cmd/dasheval -cases ../../evals/dashboards [-answers dir] [-prometheus URL] [-json out.json] [ids...]
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/eval"
)

func main() {
	casesDir := flag.String("cases", "../../evals/dashboards", "the cases directory")
	answers := flag.String("answers", "", "a directory of <case id>.json answers (default: each case's reference.json)")
	prom := flag.String("prometheus", "", "a Prometheus base URL to run the queries on")
	out := flag.String("json", "", "also write the results as JSON here")
	flag.Parse()

	cases, err := eval.LoadCases(*casesDir)
	if err != nil {
		fail(err)
	}
	var q eval.Querier
	if *prom != "" {
		q = eval.Prometheus{Base: *prom}
	}
	only := flag.Args()
	var results []eval.Result
	passed := 0
	for _, c := range cases {
		if len(only) > 0 && !picked(c.ID, only) {
			continue
		}
		path := filepath.Join(*casesDir, c.ID, "reference.json")
		if *answers != "" {
			path = filepath.Join(*answers, c.ID+".json")
		}
		answer, err := os.ReadFile(path)
		var r eval.Result
		if err != nil {
			r = eval.Result{Case: c.ID, Checks: []eval.Check{{Name: "answer", Detail: err.Error()}}}
		} else {
			r = eval.Grade(context.Background(), c, answer, q)
		}
		results = append(results, r)
		mark := "FAIL"
		if r.Pass {
			mark, passed = "pass", passed+1
		}
		fmt.Printf("%-24s %s  %d checks\n", c.ID, mark, len(r.Checks))
		for _, f := range r.Failed() {
			fmt.Printf("    ✗ %s: %s\n", f.Name, f.Detail)
		}
	}
	fmt.Printf("\n%d/%d passed (live: %v)\n", passed, len(results), q != nil)
	if *out != "" {
		b, _ := json.MarshalIndent(results, "", "  ")
		if err := os.WriteFile(*out, b, 0o644); err != nil {
			fail(err)
		}
	}
	if passed != len(results) {
		os.Exit(1)
	}
}

func picked(id string, only []string) bool {
	for _, o := range only {
		if strings.HasPrefix(id, o) {
			return true
		}
	}
	return false
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(2)
}
