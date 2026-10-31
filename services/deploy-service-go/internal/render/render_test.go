package render

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sigs.k8s.io/yaml"

	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/spec"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/target"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden.yaml")

type testCase struct {
	Name          string   `json:"name"`
	Score         string   `json:"score,omitempty"`
	Inline        string   `json:"inline,omitempty"`
	Overrides     []string `json:"overrides,omitempty"`
	Env           string   `json:"env"`
	Patches       []string `json:"patches,omitempty"`
	PatchesInline string   `json:"patchesInline,omitempty"`
	Raw           []string `json:"raw,omitempty"`
	RawInline     string   `json:"rawInline,omitempty"`
	Error         []string `json:"error,omitempty"`
}

// peers stands for the other workloads of the environment.
var peers = map[string]map[string]int{"api": {"grpc": 9090}}

func readCases(t testing.TB) []testCase {
	t.Helper()
	data, err := os.ReadFile("testdata/cases.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var cases []testCase
	if err := yaml.UnmarshalStrict(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func readTestdata(t testing.TB, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func caseInput(t testing.TB, c testCase) (*Result, error) {
	t.Helper()
	in := spec.Input{Files: os.DirFS("testdata/files")}
	if c.Inline != "" {
		in.Score = []byte(c.Inline)
	} else {
		in.Score = readTestdata(t, c.Score)
	}
	for _, o := range c.Overrides {
		in.Overrides = append(in.Overrides, readTestdata(t, o))
	}
	env, err := target.Parse(readTestdata(t, c.Env))
	if err != nil {
		t.Fatal(err)
	}
	s, err := spec.Load(in)
	if err != nil {
		return nil, err
	}
	ri := Input{Spec: s, Env: env, Peers: peers}
	for _, p := range c.Patches {
		ri.Patches = append(ri.Patches, File{Name: p, Data: readTestdata(t, p)})
	}
	if c.PatchesInline != "" {
		ri.Patches = append(ri.Patches, File{Name: "inline", Data: []byte(c.PatchesInline)})
	}
	for _, p := range c.Raw {
		ri.Raw = append(ri.Raw, File{Name: p, Data: readTestdata(t, p)})
	}
	if c.RawInline != "" {
		ri.Raw = append(ri.Raw, File{Name: "inline", Data: []byte(c.RawInline)})
	}
	return Render(ri)
}

func goldenText(t testing.TB, res *Result) string {
	t.Helper()
	y, err := res.YAML()
	if err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	for _, n := range res.Notes {
		fmt.Fprintf(&b, "# note: %s\n", n)
	}
	b.Write(y)
	if len(res.ClusterScoped) > 0 {
		waiting, err := (&Result{Objects: res.ClusterScoped}).YAML()
		if err != nil {
			t.Fatal(err)
		}
		b.WriteString("# ---- cluster-scoped, waiting for a platform admin's approval ----\n---\n")
		b.Write(waiting)
	}
	return b.String()
}

func TestGolden(t *testing.T) {
	for _, c := range readCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			res, err := caseInput(t, c)
			if len(c.Error) > 0 {
				if err == nil {
					t.Fatalf("rendered without the expected error %q", c.Error)
				}
				for _, want := range c.Error {
					if !strings.Contains(err.Error(), want) {
						t.Errorf("error lacks %q:\n%v", want, err)
					}
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := goldenText(t, res)
			path := filepath.Join("testdata", c.Name+".golden.yaml")
			if *update {
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("%v (run with -update to write it)", err)
			}
			if got != string(want) {
				t.Errorf("render differs from %s:\n%s", path, firstDiff(string(want), got))
			}
		})
	}
}

func firstDiff(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := 0; i < len(w) || i < len(g); i++ {
		var wl, gl string
		if i < len(w) {
			wl = w[i]
		}
		if i < len(g) {
			gl = g[i]
		}
		if wl != gl {
			return fmt.Sprintf("line %d\n want: %q\n  got: %q", i+1, wl, gl)
		}
	}
	return "(same lines, different bytes)"
}

// TestSameBytes renders the same input repeatedly: Go map order must never
// reach the output, or every sync would see a diff.
func TestSameBytes(t *testing.T) {
	c := testCase{Score: "web.score.yaml", Env: "env-alpha.yaml"}
	first := ""
	for i := 0; i < 30; i++ {
		res, err := caseInput(t, c)
		if err != nil {
			t.Fatal(err)
		}
		got := goldenText(t, res)
		if i == 0 {
			first = got
		} else if got != first {
			t.Fatalf("render %d differs:\n%s", i, firstDiff(first, got))
		}
	}
}

// TestEveryObjectCarriesItsOwner checks what sync relies on to leave other
// owners' objects alone: the labels, the namespace and an owner annotation
// that names the object itself.
func TestEveryObjectCarriesItsOwner(t *testing.T) {
	for _, c := range readCases(t) {
		if len(c.Error) > 0 {
			continue
		}
		res, err := caseInput(t, c)
		if err != nil {
			t.Fatal(err)
		}
		env, _ := target.Parse(readTestdata(t, c.Env))
		check := func(o Object, cluster bool) {
			md := o["metadata"].(Object)
			kind, name := o["kind"].(string), md["name"].(string)
			labels := md["labels"].(Object)
			svc := labels[labelService].(string)
			want := fmt.Sprintf("%s/%s/%s/%s", env.Name, svc, kind, name)
			if got := md["annotations"].(Object)[annOwner]; got != want {
				t.Errorf("%s %s %s: owner %v, want %s", c.Name, kind, name, got, want)
			}
			ns, _ := env.NamespaceFor(svc)
			if cluster {
				if _, has := md["namespace"]; has {
					t.Errorf("%s %s %s: a cluster-scoped object has a namespace", c.Name, kind, name)
				}
			} else if md["namespace"] != ns {
				t.Errorf("%s %s %s: namespace %v, want %s", c.Name, kind, name, md["namespace"], ns)
			}
			if labels[labelManagedBy] != managedBy || labels[labelEnv] != env.Name || labels[labelName] != svc {
				t.Errorf("%s %s %s: labels %v", c.Name, kind, name, labels)
			}
		}
		for _, o := range res.Objects {
			check(o, false)
		}
		for _, o := range res.ClusterScoped {
			check(o, true)
		}
	}
}

// TestSecretsNeverInline checks that no secret marker or value-like output
// reaches a rendered object: secrets are references only.
func TestSecretsNeverInline(t *testing.T) {
	res, err := caseInput(t, testCase{Score: "web.score.yaml", Env: "env-alpha.yaml"})
	if err != nil {
		t.Fatal(err)
	}
	y, err := res.YAML()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(y), "kubeast-secret") {
		t.Fatal("a secret marker reached the output")
	}
	for _, want := range []string{
		"name: KUBEAST_SECRET_DB_PASSWORD",
		"value: postgres://$(KUBEAST_SECRET_DB_USERNAME):$(KUBEAST_SECRET_DB_PASSWORD)@db.internal:5432/web",
	} {
		if !strings.Contains(string(y), want) {
			t.Errorf("output lacks %q", want)
		}
	}
}
