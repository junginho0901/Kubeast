package grafana

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"sort"
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

// A dashboard changed since its v2 import is refused: writing the change
// into its v2 file is not built yet.
func TestExportV2_RefusesAChangedV2(t *testing.T) {
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
}

// A classic dashboard and one made in Kubeast go out as their classic export
// converted (ConvertV2, tested against Grafana 13.3.0): a v2 resource with
// the name only, which imports back with the same panels, queries, layout
// and variables. A Kubeast-made one keeps no ${DS_…} input.
func TestExportV2_ConvertsClassicAndKubeastMade(t *testing.T) {
	count := 0
	for _, c := range convCases(t) {
		if c.v2 || c.direct {
			continue
		}
		var d *model.Dashboard
		if strings.HasPrefix(c.key, "kubeast/") {
			d = nativeByKey(t, c.key)
		} else {
			var err error
			if d, _, err = Import(c.raw); err != nil {
				t.Fatalf("%s: %v", c.key, err)
			}
		}
		out, rep, err := ExportV2(d)
		if err != nil {
			t.Fatalf("%s: %v", c.key, err)
		}
		count++
		var got struct {
			APIVersion string            `json:"apiVersion"`
			Kind       string            `json:"kind"`
			Metadata   map[string]string `json:"metadata"`
			Spec       json.RawMessage   `json:"spec"`
		}
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatal(err)
		}
		if got.APIVersion != "dashboard.grafana.app/v2" || got.Kind != "Dashboard" || len(got.Metadata) != 1 || got.Metadata["name"] == "" {
			t.Errorf("%s: %s %s %v", c.key, got.APIVersion, got.Kind, got.Metadata)
		}
		classic, crep, _ := Export(d)
		want, _ := ConvertV2(classic, exportDataSources(d))
		native := strings.HasPrefix(c.key, "kubeast/")
		var uid struct{ UID string }
		_ = json.Unmarshal(classic, &uid)
		if wantName := map[bool]string{true: d.Metadata.Name, false: uid.UID}[uid.UID == ""]; got.Metadata["name"] != wantName {
			t.Errorf("%s: metadata name %q, want %q (the classic uid, else the dashboard name)", c.key, got.Metadata["name"], wantName)
		}
		if !native && !jsonEqual(t, got.Spec, want) {
			t.Errorf("%s: the spec is not the classic export converted", c.key)
		}
		if native {
			if strings.Contains(string(out), "${DS_") || len(rep.Inputs) != 0 {
				t.Errorf("%s: an input is left: %v", c.key, rep.Inputs)
			}
			reported := false
			for _, f := range rep.Adjusted {
				reported = reported || strings.Contains(f.Reason, "written without a data source")
			}
			if reported != (len(crep.Inputs) > 0) {
				t.Errorf("%s: removed input references reported %v, inputs %v", c.key, reported, crep.Inputs)
			}
			var stores, groups []string
			for _, p := range d.Spec.Panels {
				for _, q := range p.Queries {
					stores = append(stores, q.Store)
				}
			}
			var spec struct {
				Elements map[string]struct {
					Spec struct {
						Data struct {
							Spec struct {
								Queries []struct {
									Spec struct {
										Query struct {
											Group string `json:"group"`
										} `json:"query"`
									} `json:"spec"`
								} `json:"queries"`
							} `json:"spec"`
						} `json:"data"`
					} `json:"spec"`
				} `json:"elements"`
			}
			_ = json.Unmarshal(got.Spec, &spec)
			for _, e := range spec.Elements {
				for _, q := range e.Spec.Data.Spec.Queries {
					groups = append(groups, q.Spec.Query.Group)
				}
			}
			sort.Strings(stores)
			sort.Strings(groups)
			if strings.Join(stores, ",") != strings.Join(groups, ",") {
				t.Errorf("%s: query groups %v, want the stores %v", c.key, groups, stores)
			}
		}
		again, _, err := Import(out)
		if err != nil {
			t.Fatalf("%s: the v2 export does not import: %v", c.key, err)
		}
		if a, b := contents(again), contents(d); a != b {
			t.Errorf("%s: imports back differently:\n got  %s\n want %s", c.key, a, b)
		}
	}
	if count < 147 {
		t.Errorf("%d dashboards exported, want every classic and Kubeast-made one", count)
	}
}

// contents is shape without the positions, which Grafana's v1 → v2 → v1
// does not keep for rows (it stacks them again).
func contents(d *model.Dashboard) string {
	parts := strings.SplitN(shape(d), " || ", 2)
	items := strings.Split(parts[0], " | ")
	sort.Strings(items)
	return strings.Join(items, " | ") + " || " + parts[1]
}

// nativeByKey reads a Kubeast-made dashboard of convCases by its key.
func nativeByKey(t *testing.T, key string) *model.Dashboard {
	t.Helper()
	f := filepath.Join("../../../../../evals/dashboards", strings.TrimPrefix(key, "kubeast/"), "reference.json")
	if key == "kubeast/web-red" {
		f = "../../../schema/examples/web-red.json"
	}
	var d model.Dashboard
	if err := json.Unmarshal(mustRead(t, f), &d); err != nil {
		t.Fatal(err)
	}
	return &d
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}
