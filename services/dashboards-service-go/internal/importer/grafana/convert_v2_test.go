package grafana

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// grafanaDataSources are the data sources of the Grafana 13.3.0 that wrote
// the test data: one per store, its uid and name the plugin id, Prometheus
// the default, and one whose name is not its uid (testdata/convert only).
var grafanaDataSources = DataSources{
	{UID: "prometheus", Name: "prometheus", Type: "prometheus", Default: true},
	{UID: "loki", Name: "loki", Type: "loki"},
	{UID: "tempo", Name: "tempo", Type: "tempo"},
	{UID: "named-uid", Name: "Named DS", Type: "tempo"},
}

// converted reads converted.tar.gz: direct/<key>.json is the v2 spec Grafana
// 13.3.0 served for a classic file stored as it is, export/<key>.json the one
// for Kubeast's classic export of it where that differs. The corpus files'
// direct answers are pairs.tar.gz's v2 documents (pairsV2).
func converted(t *testing.T) map[string]any {
	t.Helper()
	f, err := os.Open("testdata/grafana-13.3.0-v2/converted.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]any{}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		var v any
		if err := json.Unmarshal(b, &v); err != nil {
			t.Fatalf("%s: %v", h.Name, err)
		}
		out[strings.TrimSuffix(h.Name, ".json")] = v
	}
	return out
}

func pairsV2(t *testing.T) map[string]any {
	t.Helper()
	out := map[string]any{}
	for _, p := range corpusPairs(t) {
		var v map[string]any
		if err := json.Unmarshal(p.v2, &v); err != nil {
			t.Fatal(err)
		}
		out[p.name] = v["spec"]
	}
	return out
}

type convCase struct {
	key    string
	raw    []byte
	v2     bool // a v2 file: only its classic export is converted
	direct bool // a file made for the converter: converted as it is only
}

// convCases: the corpus, edge-cases, Grafana's v1 of every v2 sample, the v2
// samples themselves, the Kubeast-made dashboards as Export writes them with
// each ${DS_…} input answered by the data source of its plugin, and
// testdata/convert, which holds what the others do not (every variable kind,
// actions, value mappings, data sources by name, old panels, repeats, and a
// dashboard at schemaVersion 36 for each branch of the migrations to 42).
func convCases(t *testing.T) []convCase {
	t.Helper()
	cases := []convCase{{key: "edge-cases", raw: mustRead(t, "testdata/edge-cases.json")}}
	for _, n := range []string{"panels", "variables", "migrations"} {
		cases = append(cases, convCase{key: "convert/" + n, raw: mustRead(t, "testdata/convert/"+n+".json"), direct: true})
	}
	for _, f := range corpusFiles(t) {
		cases = append(cases, convCase{key: strings.TrimSuffix(strings.TrimPrefix(f, "testdata/"), ".json"), raw: mustRead(t, f)})
	}
	for _, p := range nativePairs(t) {
		cases = append(cases, convCase{key: "native-v1/" + p.name, raw: p.v1}, convCase{key: "native-v2/" + p.name, raw: p.v2, v2: true})
	}
	for _, p := range corpusPairs(t) {
		cases = append(cases, convCase{key: "pairs-v1/" + p.name, raw: p.v1}, convCase{key: "pairs-v2/" + p.name, raw: p.v2, v2: true})
	}
	input := regexp.MustCompile(`\$\{DS_([A-Z]+)\}`)
	files, _ := filepath.Glob("../../../../../evals/dashboards/*/reference.json")
	files = append(files, "../../../schema/examples/web-red.json")
	for _, f := range files {
		var d model.Dashboard
		if json.Unmarshal(mustRead(t, f), &d) != nil || d.APIVersion == "" {
			continue // a decline answer
		}
		out, _, err := Export(&d)
		if err != nil {
			t.Fatal(err)
		}
		out = input.ReplaceAllFunc(out, func(m []byte) []byte { return []byte(strings.ToLower(string(m[5 : len(m)-1]))) })
		name := filepath.Base(filepath.Dir(f))
		if strings.HasSuffix(f, "web-red.json") {
			name = "web-red"
		}
		cases = append(cases, convCase{key: "kubeast/" + name, raw: out})
	}
	return cases
}

// direct is Grafana's v2 of the case's own file.
func direct(c convCase, conv, pairs map[string]any) (any, bool) {
	if v, ok := conv["direct/"+c.key]; ok {
		return v, true
	}
	name := strings.TrimPrefix(c.key, "corpus/")
	if strings.HasPrefix(name, "grafana-13.3.0-v1-resource/") {
		name = strings.TrimPrefix(name, "grafana-13.3.0-v1-resource/")
	}
	v, ok := pairs[strings.ReplaceAll(name, "/", "__")]
	return v, ok
}

// classicOf unwraps a v1 resource to the classic dashboard inside it.
func classicOf(t *testing.T, raw []byte) []byte {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if spec, ok := m["spec"]; ok && m["apiVersion"] != nil {
		return spec
	}
	return raw
}

// checkConverted converts raw and compares the spec with Grafana's, every
// value and every key, or expects the refusal of a schemaVersion before 36.
func checkConverted(t *testing.T, key string, raw []byte, want any) (compared bool) {
	t.Helper()
	got, err := ConvertV2(raw, grafanaDataSources)
	var probe struct{ SchemaVersion int }
	_ = json.Unmarshal(raw, &probe)
	if probe.SchemaVersion < minSchemaVersion {
		if !errors.Is(err, ErrV2SchemaVersion) {
			t.Errorf("%s: schemaVersion %d gave %v, want ErrV2SchemaVersion", key, probe.SchemaVersion, err)
		}
		return false
	}
	if err != nil {
		t.Errorf("%s: %v", key, err)
		return false
	}
	var g any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, want) {
		d := diffPaths("", want, g, 6)
		if len(d) == 0 {
			d = []string{"a key with null on one side is missing on the other"}
		}
		t.Errorf("%s: differs from Grafana 13.3.0's v2 (Grafana's first, then ours): %v", key, d)
	}
	return true
}

// TestConvertV2_AsGrafana: each classic file converts to the spec Grafana
// 13.3.0 serves for it as v2, exactly.
func TestConvertV2_AsGrafana(t *testing.T) {
	conv, pairs := converted(t), pairsV2(t)
	compared, refused := 0, 0
	for _, c := range convCases(t) {
		if c.v2 {
			continue
		}
		want, ok := direct(c, conv, pairs)
		if !ok {
			t.Fatalf("%s: no Grafana answer", c.key)
		}
		if checkConverted(t, c.key, classicOf(t, c.raw), want) {
			compared++
		} else {
			refused++
		}
	}
	if compared != 150 || refused != 0 {
		t.Errorf("compared %d, refused %d; want every one of the 150 files", compared, refused)
	}
}

// A schemaVersion before 36 is refused, and one after 42, on which Grafana
// 13.3.0's conversion fails too (status.conversion.failed).
func TestConvertV2_SchemaVersionRange(t *testing.T) {
	raw := string(mustRead(t, "testdata/convert/migrations.json"))
	for _, sv := range []string{"35", "43"} {
		_, err := ConvertV2([]byte(strings.Replace(raw, `"schemaVersion": 36`, `"schemaVersion": `+sv, 1)), grafanaDataSources)
		if !errors.Is(err, ErrV2SchemaVersion) || !strings.Contains(err.Error(), "at "+sv) {
			t.Errorf("schemaVersion %s: err = %v, want ErrV2SchemaVersion naming it", sv, err)
		}
	}
}

// A group by variable without a data source of a known type is refused:
// Grafana 13.3.0 panics on it (HTTP 500 on GET v2).
func TestConvertV2_GroupByWithoutType(t *testing.T) {
	_, err := ConvertV2(mustRead(t, "testdata/convert/groupby-no-type.json"), grafanaDataSources)
	if err == nil || !strings.Contains(err.Error(), `group by variable "g"`) {
		t.Errorf("err = %v, want the group by variable named", err)
	}
}

// TestConvertV2_ExportAsGrafana: what Kubeast imports and exports as classic
// converts to the spec Grafana 13.3.0 serves for that export, the v2 samples
// included.
func TestConvertV2_ExportAsGrafana(t *testing.T) {
	conv, pairs := converted(t), pairsV2(t)
	compared, refused := 0, 0
	for _, c := range convCases(t) {
		if c.direct {
			continue
		}
		raw := c.raw
		if !strings.HasPrefix(c.key, "kubeast/") {
			d, _, err := Import(c.raw)
			if err != nil {
				t.Fatalf("%s: %v", c.key, err)
			}
			if raw, _, err = Export(d); err != nil {
				t.Fatalf("%s: %v", c.key, err)
			}
		}
		want, ok := conv["export/"+c.key]
		if !ok && !c.v2 {
			want, ok = direct(c, conv, pairs)
		}
		if !ok {
			t.Fatalf("%s: no Grafana answer", c.key)
		}
		if checkConverted(t, c.key, raw, want) {
			compared++
		} else {
			refused++
		}
	}
	if compared != 207 || refused != 0 {
		t.Errorf("compared %d, refused %d; want every one of the 207 exports", compared, refused)
	}
}
