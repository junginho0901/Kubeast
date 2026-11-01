package grafana

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

var update = flag.Bool("update", false, "rewrite testdata/corpus/SUMMARY.txt")

// CorpusFiles lists the published dashboards in testdata/corpus (see its
// SOURCES.md), relative to the package directory.
func corpusFiles(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob("testdata/corpus/*/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no corpus files: %v", err)
	}
	sort.Strings(files)
	return files
}

// droppable: Grafana's database id, and the envelope Grafana 12+ wraps a
// served dashboard in (its instance record; source.raw keeps it).
var droppable = map[string]bool{"id": true, "apiVersion": true, "kind": true, "metadata": true, "status": true}

// TestGrafana13V2_RefusedWithGuidance: Grafana 13's default export (schema
// v2) is not imported yet; the error says how to export a form that is.
func TestGrafana13V2_RefusedWithGuidance(t *testing.T) {
	files, _ := filepath.Glob("testdata/grafana-13.3.0-v2/*.json")
	if len(files) == 0 {
		t.Fatal("no v2 samples")
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := Import(raw); err != ErrNotV1Schema {
			t.Errorf("%s: err = %v, want ErrNotV1Schema", f, err)
		}
	}
	if !strings.Contains(ErrNotV1Schema.Error(), "Classic or V1 Resource") {
		t.Errorf("the error should say how to export an importable form: %v", ErrNotV1Schema)
	}
}

// TestCorpus imports every published dashboard: each must import, validate,
// account for every key it has, give the same bytes twice and drop nothing but
// Grafana's database id. SUMMARY.txt records what each one needed, so a
// change in what the importer keeps, adjusts or cannot draw shows in review.
func TestCorpus(t *testing.T) {
	var summary bytes.Buffer
	unsupported := map[string]int{}
	for _, f := range corpusFiles(t) {
		name := strings.TrimPrefix(f, "testdata/corpus/")
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		d, rep, err := Import(raw)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if probs := model.Validate(d); len(probs) != 0 {
			t.Errorf("%s: not valid: %v", name, probs)
		}
		missing, err := unaccounted(raw, rep)
		if err != nil {
			t.Fatal(err)
		}
		if len(missing) != 0 {
			t.Errorf("%s: keys read by nobody (lost on import): %v", name, missing)
		}
		for _, p := range rep.Dropped {
			if !droppable[p] {
				t.Errorf("%s: dropped %s; only Grafana's database id and resource envelope may be dropped", name, p)
			}
		}
		first, _ := json.Marshal(d)
		again, _, _ := Import(raw)
		second, _ := json.Marshal(again)
		if !bytes.Equal(first, second) {
			t.Errorf("%s: importing twice gives different bytes", name)
		}
		for _, u := range rep.Unsupported {
			unsupported[u.Reason]++
		}
		fmt.Fprintf(&summary, "%s\tpanels %d\tpreserved %d\tadjusted %d\tunsupported %d\n",
			name, rep.Panels, len(rep.Preserved), len(rep.Adjusted), len(rep.Unsupported))
	}
	reasons := make([]string, 0, len(unsupported))
	for r := range unsupported {
		reasons = append(reasons, r)
	}
	sort.Strings(reasons)
	for _, r := range reasons {
		fmt.Fprintf(&summary, "unsupported\t%d\t%s\n", unsupported[r], r)
	}
	const golden = "testdata/corpus/SUMMARY.txt"
	if *update {
		if err := os.WriteFile(golden, summary.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("%v (write it with go test -run TestCorpus -update)", err)
	}
	if !bytes.Equal(want, summary.Bytes()) {
		t.Errorf("%s differs from this run (rewrite it with go test -run TestCorpus -update and review the diff)", golden)
	}
}
