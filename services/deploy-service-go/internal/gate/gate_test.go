package gate

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"sigs.k8s.io/yaml"

	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/render"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/spec"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/target"
)

var update = flag.Bool("update", false, "rewrite testdata/*.gate.txt")

// The gate is checked on the renderer's own golden cases, so what the
// golden path renders and what the gate accepts cannot drift apart.
const renderData = "../render/testdata"

type renderCase struct {
	Name      string   `json:"name"`
	Score     string   `json:"score,omitempty"`
	Inline    string   `json:"inline,omitempty"`
	Overrides []string `json:"overrides,omitempty"`
	Env       string   `json:"env"`
	Patches   []string `json:"patches,omitempty"`
	Raw       []string `json:"raw,omitempty"`
	// The refused cases' other fields are not needed here.
	PatchesInline string   `json:"patchesInline,omitempty"`
	RawInline     string   `json:"rawInline,omitempty"`
	Error         []string `json:"error,omitempty"`
}

func read(t testing.TB, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(renderData, name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func renderCases(t testing.TB) []renderCase {
	var cases []renderCase
	if err := yaml.UnmarshalStrict(read(t, "cases.yaml"), &cases); err != nil {
		t.Fatal(err)
	}
	var out []renderCase
	for _, c := range cases {
		if len(c.Error) == 0 {
			out = append(out, c)
		}
	}
	return out
}

type rendered struct {
	env *target.Env
	ext spec.Ext
	res *render.Result
}

func renderFor(t testing.TB, c renderCase) rendered {
	t.Helper()
	in := spec.Input{Score: read(t, c.Score), Files: os.DirFS(filepath.Join(renderData, "files"))}
	for _, o := range c.Overrides {
		in.Overrides = append(in.Overrides, read(t, o))
	}
	s, err := spec.Load(in)
	if err != nil {
		t.Fatal(err)
	}
	env, err := target.Parse(read(t, c.Env))
	if err != nil {
		t.Fatal(err)
	}
	ri := render.Input{Spec: s, Env: env, Peers: map[string]map[string]int{"api": {"grpc": 9090}}}
	for _, p := range c.Patches {
		ri.Patches = append(ri.Patches, render.File{Name: p, Data: read(t, p)})
	}
	for _, p := range c.Raw {
		ri.Raw = append(ri.Raw, render.File{Name: p, Data: read(t, p)})
	}
	res, err := render.Render(ri)
	if err != nil {
		t.Fatal(err)
	}
	return rendered{env: env, ext: s.Ext, res: res}
}

func objects(res *render.Result) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(res.Objects)+len(res.ClusterScoped))
	for _, o := range res.Objects {
		out = append(out, o)
	}
	for _, o := range res.ClusterScoped {
		out = append(out, o)
	}
	return out
}

func newGate(t testing.TB, cfg Config) *Gate {
	t.Helper()
	g, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { g.Close() })
	return g
}

func reportText(r Report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "blocked: %v\n", r.Blocked())
	for _, f := range r.Findings {
		state := ""
		switch {
		case f.Excepted:
			state = " [excepted]"
		case f.Waiting:
			state = " [exception waiting]"
		}
		fmt.Fprintf(&b, "%-7s %s %s %s: %s%s\n", f.Mode, f.Kind, f.Name, f.Rule, f.Message, state)
	}
	for _, n := range r.Notes {
		fmt.Fprintf(&b, "note: %s\n", n)
	}
	return b.String()
}

func TestGateOnRenderGoldens(t *testing.T) {
	for _, c := range renderCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			r := renderFor(t, c)
			g := newGate(t, ConfigFor(r.env, nil))
			rep, err := g.Check(context.Background(), Input{Objects: objects(r.res), Exceptions: r.ext.PolicyExceptions})
			if err != nil {
				t.Fatal(err)
			}
			got := reportText(rep)
			path := filepath.Join("testdata", c.Name+".gate.txt")
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
				t.Errorf("gate report differs from %s:\n--- want\n%s--- got\n%s", path, want, got)
			}
		})
	}
}

// The golden path itself must pass the gate wherever the cluster can take it.
func TestGoldenPathPasses(t *testing.T) {
	for _, name := range []string{"minimal", "web-alpha", "web-prod", "routed-bare-cluster"} {
		for _, c := range renderCases(t) {
			if c.Name != name {
				continue
			}
			r := renderFor(t, c)
			rep, err := newGate(t, ConfigFor(r.env, nil)).Check(context.Background(), Input{Objects: objects(r.res)})
			if err != nil {
				t.Fatal(err)
			}
			if len(rep.Findings) > 0 {
				t.Errorf("%s: the golden path has findings:\n%s", name, reportText(rep))
			}
		}
	}
}

func webAlpha(t testing.TB) rendered {
	for _, c := range renderCases(t) {
		if c.Name == "web-alpha" {
			return renderFor(t, c)
		}
	}
	t.Fatal("no web-alpha case")
	return rendered{}
}

func deployment(objs []map[string]interface{}) map[string]interface{} {
	for _, o := range objs {
		if o["kind"] == "Deployment" {
			return o
		}
	}
	return nil
}

func TestSchemaFindings(t *testing.T) {
	objs := objects(webAlpha(t).res)
	d := deployment(objs)
	d["spec"].(map[string]interface{})["replicas"] = "three"
	d["spec"].(map[string]interface{})["template"].(map[string]interface{})["spec"].(map[string]interface{})["containerz"] = []interface{}{}
	rep, err := newGate(t, Config{}).Check(context.Background(), Input{Objects: objs})
	if err != nil {
		t.Fatal(err)
	}
	text := reportText(rep)
	if !rep.Blocked() || !strings.Contains(text, "/spec/replicas") || !strings.Contains(text, "containerz") {
		t.Errorf("schema findings missing:\n%s", text)
	}
}

func TestModesAndExceptions(t *testing.T) {
	objs := objects(webAlpha(t).res)
	d := deployment(objs)
	c := d["spec"].(map[string]interface{})["template"].(map[string]interface{})["spec"].(map[string]interface{})["containers"].([]interface{})[0].(map[string]interface{})
	c["image"] = "nginx"                                               // image-tag
	c["securityContext"].(map[string]interface{})["privileged"] = true // no-privileged

	ctx := context.Background()
	rep, _ := newGate(t, Config{}).Check(ctx, Input{Objects: objs})
	if !rep.Blocked() || !hasRule(rep, "image-tag") || !hasRule(rep, "no-privileged") {
		t.Fatalf("enforce by default:\n%s", reportText(rep))
	}

	rep, _ = newGate(t, Config{Modes: map[string]Mode{"image-tag": Warn, "no-privileged": Off}}).Check(ctx, Input{Objects: objs})
	if rep.Blocked() || !hasRule(rep, "image-tag") || hasRule(rep, "no-privileged") {
		t.Fatalf("warn keeps the finding without blocking, off drops it:\n%s", reportText(rep))
	}

	g := newGate(t, Config{Modes: map[string]Mode{"no-privileged": Off}})
	rep, _ = g.Check(ctx, Input{Objects: objs, Exceptions: []string{"image-tag", "seccomp-profile"}})
	if !rep.Blocked() || !strings.Contains(reportText(rep), "[exception waiting]") {
		t.Fatalf("an exception to an enforced rule waits for approval and still blocks:\n%s", reportText(rep))
	}
	if !strings.Contains(reportText(rep), `exception "seccomp-profile" matched no finding`) {
		t.Errorf("an unused exception is noted:\n%s", reportText(rep))
	}
	rep, _ = g.Check(ctx, Input{Objects: objs, Exceptions: []string{"image-tag"}, Approved: map[string]bool{"image-tag": true}})
	if rep.Blocked() || !strings.Contains(reportText(rep), "[excepted]") {
		t.Fatalf("an approved exception lets it through, still shown:\n%s", reportText(rep))
	}

	if _, err := New(ctx, Config{Modes: map[string]Mode{"image-tag": "maybe"}}); err == nil {
		t.Error("an unknown mode was accepted")
	}
}

func hasRule(r Report, rule string) bool {
	for _, f := range r.Findings {
		if f.Rule == rule {
			return true
		}
	}
	return false
}

func TestInstallerPolicy(t *testing.T) {
	team := File{Name: "team.rego", Data: []byte(`package kubeast.deploy

import rego.v1

finding contains f if {
	some obj in input.objects
	not obj.metadata.labels["team.example.com/owner"]
	f := {"rule": "team-label", "kind": obj.kind, "name": obj.metadata.name, "msg": "label team.example.com/owner is required"}
}
`)}
	objs := objects(webAlpha(t).res)
	rep, err := newGate(t, Config{Policies: []File{team}, Modes: map[string]Mode{"team-label": Warn}}).Check(context.Background(), Input{Objects: objs})
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, f := range rep.Findings {
		if f.Rule == "team-label" {
			n++
		}
	}
	if n != len(objs) || rep.Blocked() {
		t.Errorf("installer rule: %d findings for %d objects, blocked %v", n, len(objs), rep.Blocked())
	}

	broken := File{Name: "broken.rego", Data: []byte("package kubeast.deploy\nfinding contains if {")}
	if _, err := New(context.Background(), Config{Policies: []File{broken}}); err == nil || !strings.Contains(err.Error(), "broken.rego") {
		t.Errorf("a broken module must fail New and name its file: %v", err)
	}
}

func TestAllowedRegistries(t *testing.T) {
	objs := objects(webAlpha(t).res)
	rep, _ := newGate(t, Config{AllowedRegistries: []string{"registry.example.com/"}}).Check(context.Background(), Input{Objects: objs})
	if !hasRule(rep, "allowed-registry") || !rep.Blocked() {
		t.Errorf("an image outside the allowed registries passed:\n%s", reportText(rep))
	}
	rep, _ = newGate(t, Config{AllowedRegistries: []string{"ghcr.io/example/"}}).Check(context.Background(), Input{Objects: objs})
	if hasRule(rep, "allowed-registry") {
		t.Errorf("an allowed image was refused:\n%s", reportText(rep))
	}
}

func TestConcurrentChecks(t *testing.T) {
	objs := objects(webAlpha(t).res)
	g := newGate(t, Config{})
	want, _ := g.Check(context.Background(), Input{Objects: objs})
	var wg sync.WaitGroup
	errs := make(chan string, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := g.Check(context.Background(), Input{Objects: objs})
			if err != nil || reportText(got) != reportText(want) {
				errs <- fmt.Sprintf("%v %s", err, reportText(got))
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
}

// TestEmbeddedKindsMatchTheArchive keeps the warm-up list and the archive
// together: every listed kind has its file, every file a listed kind.
func TestEmbeddedKindsMatchTheArchive(t *testing.T) {
	g := newGate(t, Config{})
	files := map[string]bool{}
	entries, _ := os.ReadDir(g.dir)
	for _, e := range entries {
		files[e.Name()] = true
	}
	for _, k := range embeddedKinds {
		group, version, found := strings.Cut(k[0], "/")
		suffix := "-" + group
		if !found {
			suffix, version = "", group
		}
		name := strings.ToLower(k[1]) + strings.ToLower(strings.Split(suffix, ".")[0]) + "-" + version + ".json"
		if !files[name] {
			t.Errorf("%s %s: no %s in the archive", k[0], k[1], name)
		}
		delete(files, name)
	}
	for f := range files {
		t.Errorf("%s in the archive has no kind in embeddedKinds", f)
	}
	// Each embedded kind is known: a warm object raises no schema-missing.
	rep, _ := g.Check(context.Background(), Input{Objects: []map[string]interface{}{{"apiVersion": "batch/v1", "kind": "CronJob", "metadata": map[string]interface{}{"name": "x"}}}})
	if hasRule(rep, RuleSchemaMissing) {
		t.Errorf("CronJob schema not found:\n%s", reportText(rep))
	}
}

func TestCloseRemovesSchemas(t *testing.T) {
	g, err := New(context.Background(), Config{})
	if err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(g.dir)
	if len(entries) != 10 {
		t.Errorf("%d schemas unpacked, want 10", len(entries))
	}
	if err := g.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(g.dir); !os.IsNotExist(err) {
		t.Errorf("schema directory left behind: %v", err)
	}
}
