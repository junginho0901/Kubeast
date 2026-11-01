package grafana

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// A dashboard imported from a v2 file and not changed comes back as that
// file: the same spec (tabs, auto grids, sub headers and all), metadata with
// the name only, and an import of it gives the same model.
func TestExportV2_GivesBackTheV2File(t *testing.T) {
	type doc struct {
		name string
		raw  []byte
	}
	var docs []doc
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		docs = append(docs, doc{p.name, p.v2})
	}
	betas, _ := filepath.Glob("testdata/grafana-13.3.0-v2/native/*.v2beta1.json")
	for _, f := range betas {
		docs = append(docs, doc{filepath.Base(f), mustRead(t, f)})
	}
	if len(docs) < 60 {
		t.Fatalf("%d v2 documents, want the samples and the corpus", len(docs))
	}
	dropped := 0
	for _, dc := range docs {
		d, _, err := Import(dc.raw)
		if err != nil {
			t.Fatalf("%s: %v", dc.name, err)
		}
		out, rep, err := ExportV2(d)
		if err != nil {
			t.Fatalf("%s: %v", dc.name, err)
		}
		var orig, got map[string]any
		_ = json.Unmarshal(dc.raw, &orig)
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(orig["spec"], got["spec"]) || orig["apiVersion"] != got["apiVersion"] || got["kind"] != "Dashboard" {
			t.Errorf("%s: the export is not the v2 file", dc.name)
		}
		meta := got["metadata"].(map[string]any)
		if len(meta) != 1 || meta["name"] != orig["metadata"].(map[string]any)["name"] {
			t.Errorf("%s: metadata %v, want the name only", dc.name, meta)
		}
		if _, ok := got["status"]; ok {
			t.Errorf("%s: status kept", dc.name)
		}
		for _, f := range rep.Adjusted {
			if f.Path == "metadata.uid" || f.Path == "metadata.resourceVersion" {
				dropped++
			}
		}
		again, _, err := Import(out)
		if err != nil || !sameModel(d, again) {
			t.Errorf("%s: the export imports differently (%v)", dc.name, err)
		}
	}
	if dropped == 0 {
		t.Error("Grafana's metadata (uid, resource version) should be reported as left out, by name")
	}
}

// A changed dashboard, a classic one and one made in Kubeast need the
// classic → v2 conversion, which is refused with its reason.
func TestExportV2_RefusesWhatNeedsConversion(t *testing.T) {
	d, _, err := Import(mustRead(t, "testdata/grafana-13.3.0-v2/native/v2-tabs.v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	p := d.Spec.Panels["p1"]
	p.Title = "changed in Kubeast"
	d.Spec.Panels["p1"] = p
	if _, _, err := ExportV2(d); !errors.Is(err, ErrV2Changed) {
		t.Errorf("changed: %v, want ErrV2Changed", err)
	}

	classic, _, err := Import(mustRead(t, "testdata/edge-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := ExportV2(classic); !errors.Is(err, ErrV2NeedsConversion) {
		t.Errorf("classic: %v, want ErrV2NeedsConversion", err)
	}

	raw, err := os.ReadFile("../../../schema/examples/web-red.json")
	if err != nil {
		t.Fatal(err)
	}
	var native model.Dashboard
	if err := json.Unmarshal(raw, &native); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ExportV2(&native); !errors.Is(err, ErrV2NeedsConversion) || !strings.Contains(err.Error(), "export it as classic") {
		t.Errorf("made in Kubeast: %v, want ErrV2NeedsConversion naming the classic export", err)
	}
}
