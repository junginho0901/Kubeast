// Command dasheval grades dashboards an AI builder wrote for the requests in
// evals/dashboards (see its README). Without -answers it grades each case's
// reference answer; -prometheus, -loki and -tempo run the queries there, and
// -seed first sends the evaluation's own traces and logs.
//
//	go run ./cmd/dasheval -cases ../../evals/dashboards [-answers dir] [-prometheus URL] [-loki URL] [-tempo URL] [-seed -tempo-otlp URL] [-json out.json] [ids...]
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/eval"
)

func main() {
	casesDir := flag.String("cases", "../../evals/dashboards", "the cases directory")
	answers := flag.String("answers", "", "a directory of answers: <case id>.json, or <case id>.<n>.json for repeated runs (default: each case's reference.json)")
	prom := flag.String("prometheus", "", "a Prometheus base URL to run the PromQL on")
	loki := flag.String("loki", "", "a Loki base URL to run the LogQL on")
	tempo := flag.String("tempo", "", "a Tempo base URL to run the TraceQL on")
	otlp := flag.String("tempo-otlp", "", "Tempo's OTLP/HTTP base URL, for -seed")
	seed := flag.Bool("seed", false, "send the evaluation's traces (to -tempo-otlp) and logs (to -loki) first, then wait for them")
	out := flag.String("json", "", "also write the results as JSON here")
	flag.Parse()

	ctx := context.Background()
	cases, err := eval.LoadCases(*casesDir)
	if err != nil {
		fail(err)
	}
	var stores eval.Stores
	if *prom != "" {
		stores.Prometheus = eval.Prometheus{Base: *prom}
	}
	if *loki != "" {
		stores.Loki = eval.Loki{Base: *loki}
	}
	if *tempo != "" {
		stores.Tempo = eval.Tempo{Base: *tempo}
	}
	if *seed {
		if *otlp == "" || *loki == "" {
			fail(fmt.Errorf("-seed needs -tempo-otlp and -loki"))
		}
		now := time.Now()
		if err := eval.SeedTraces(ctx, *otlp, now); err != nil {
			fail(err)
		}
		if err := eval.SeedLogs(ctx, *loki, now); err != nil {
			fail(err)
		}
		fmt.Println("seeded the evaluation's traces and logs; waiting 30s for Tempo and Loki to serve them")
		time.Sleep(30 * time.Second)
	}

	only := flag.Args()
	var results []eval.Result
	perCase := map[string][2]int{}
	for _, c := range cases {
		if len(only) > 0 && !picked(c.ID, only) {
			continue
		}
		for _, path := range answerFiles(*casesDir, *answers, c.ID) {
			answer, err := os.ReadFile(path)
			var r eval.Result
			if err != nil {
				r = eval.Result{Case: c.ID, Checks: []eval.Check{{Name: "answer", Detail: err.Error()}}}
			} else {
				r = eval.Grade(ctx, c, answer, stores)
			}
			r.Answer = filepath.Base(path)
			results = append(results, r)
			pc := perCase[c.ID]
			pc[1]++
			mark := "FAIL"
			if r.Pass {
				pc[0]++
				mark = "pass"
			}
			perCase[c.ID] = pc
			fmt.Printf("%-28s %-26s %s  %d checks\n", c.ID, r.Answer, mark, len(r.Checks))
			for _, f := range r.Failed() {
				fmt.Printf("    ✗ %s: %s\n", f.Name, f.Detail)
			}
		}
	}
	passed := 0
	for _, r := range results {
		if r.Pass {
			passed++
		}
	}
	lo, hi := wilson(passed, len(results))
	fmt.Printf("\n%d/%d answers passed (%.0f%%; 95%% interval %.0f–%.0f%%), live: %v\n",
		passed, len(results), 100*float64(passed)/math.Max(1, float64(len(results))), 100*lo, 100*hi, stores.Prometheus != nil || stores.Loki != nil || stores.Tempo != nil)
	if len(results) > len(perCase) {
		ids := make([]string, 0, len(perCase))
		for id := range perCase {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			fmt.Printf("  %-28s %d/%d\n", id, perCase[id][0], perCase[id][1])
		}
	}
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

// answerFiles: the case's reference, or its answers in dir (one, or one per
// repeated run).
func answerFiles(casesDir, dir, id string) []string {
	if dir == "" {
		return []string{filepath.Join(casesDir, id, "reference.json")}
	}
	runs, _ := filepath.Glob(filepath.Join(dir, id+".*.json"))
	sort.Strings(runs)
	if len(runs) > 0 {
		return runs
	}
	return []string{filepath.Join(dir, id+".json")}
}

// wilson is the 95% Wilson score interval of k passes in n.
func wilson(k, n int) (float64, float64) {
	if n == 0 {
		return 0, 0
	}
	const z = 1.96
	p, nf := float64(k)/float64(n), float64(n)
	den := 1 + z*z/nf
	mid := (p + z*z/(2*nf)) / den
	half := z * math.Sqrt(p*(1-p)/nf+z*z/(4*nf*nf)) / den
	return math.Max(0, mid-half), math.Min(1, mid+half)
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
