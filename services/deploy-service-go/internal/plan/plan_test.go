package plan

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/gate"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/render"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/source"
)

func repo(t testing.TB) *Planner {
	t.Helper()
	p := New(source.NewFS(os.DirFS("testdata/repo"), "c0ffee1"))
	t.Cleanup(func() { p.Close() })
	return p
}

func find(res *render.Result, kind, name string) map[string]interface{} {
	for _, o := range res.Objects {
		if o["kind"] == kind && o["metadata"].(map[string]interface{})["name"] == name {
			return o
		}
	}
	return nil
}

func rules(r gate.Report) map[string]gate.Mode {
	out := map[string]gate.Mode{}
	for _, f := range r.Findings {
		out[f.Rule] = f.Mode
	}
	return out
}

func TestListing(t *testing.T) {
	src := source.NewFS(os.DirFS("testdata/repo"), "")
	ctx := context.Background()
	svcs, err := src.Services(ctx)
	if err != nil || strings.Join(svcs, ",") != "api,web" {
		t.Errorf("services %v %v (folders starting with _ are not workloads)", svcs, err)
	}
	envs, err := src.Environments(ctx)
	if err != nil || strings.Join(envs, ",") != "alpha,prod" {
		t.Errorf("environments %v %v", envs, err)
	}
}

func TestBuildAlpha(t *testing.T) {
	p, err := repo(t).Build(context.Background(), "web", "alpha", Options{})
	if err != nil {
		t.Fatal(err)
	}
	if p.Revision != "c0ffee1" || p.Env != "alpha" || p.Service != "web" {
		t.Errorf("plan identity %+v", p)
	}
	d := find(p.Result, "Deployment", "web")
	if d == nil {
		t.Fatal("no Deployment")
	}
	pod := d["spec"].(map[string]interface{})["template"].(map[string]interface{})["spec"].(map[string]interface{})
	if pod["terminationGracePeriodSeconds"] != 45 {
		t.Errorf("the patch from services/web/patches did not apply: %v", pod["terminationGracePeriodSeconds"])
	}
	c := pod["containers"].([]interface{})[0].(map[string]interface{})
	if c["image"] != "ghcr.io/example/web:2.0.1" {
		t.Errorf("image from environments/alpha/web.score.yaml: %v", c["image"])
	}
	var apiAddr string
	for _, e := range c["env"].([]interface{}) {
		if m := e.(map[string]interface{}); m["name"] == "API_ADDR" {
			apiAddr, _ = m["value"].(string)
		}
	}
	if apiAddr != "api:9090" {
		t.Errorf("the peer's port was not read from services/api: API_ADDR=%q", apiAddr)
	}
	if cm := find(p.Result, "ConfigMap", "web-files"); cm == nil || !strings.Contains(cm["data"].(map[string]interface{})["app-0-motd.txt"].(string), "hello from the web folder") {
		t.Errorf("the file source was not read from the workload's folder")
	}
	if find(p.Result, "CronJob", "web-cleanup") == nil {
		t.Error("the raw CronJob is missing")
	}
	// The installer's rule enforces in alpha (no mode set) and is the only finding.
	got := rules(p.Report)
	if !p.Blocked() || len(got) != 1 || got["team-label"] != gate.Enforce {
		t.Errorf("alpha report: %v", p.Report.Findings)
	}
}

func TestBuildProd(t *testing.T) {
	p, err := repo(t).Build(context.Background(), "web", "prod", Options{})
	if err != nil {
		t.Fatal(err)
	}
	got := rules(p.Report)
	if p.Blocked() || got["team-label"] != gate.Warn || len(got) != 1 {
		t.Errorf("prod warns on the team label and passes everything else: %v", p.Report.Findings)
	}
	hpa := find(p.Result, "HorizontalPodAutoscaler", "web")
	if hpa == nil || hpa["spec"].(map[string]interface{})["minReplicas"] != 4 {
		t.Errorf("prod overrides (autoscale 4-20) not applied")
	}
}

func TestBuildErrors(t *testing.T) {
	ctx := context.Background()
	p := repo(t)
	if _, err := p.Build(ctx, "billing", "alpha", Options{}); !errors.Is(err, source.ErrNotFound) {
		t.Errorf("unknown service: %v", err)
	}
	if _, err := p.Build(ctx, "web", "staging", Options{}); !errors.Is(err, source.ErrNotFound) {
		t.Errorf("unknown environment: %v", err)
	}
	for _, bad := range []string{"../web", "Web", "web/../api", ""} {
		if _, err := p.Build(ctx, bad, "alpha", Options{}); err == nil || errors.Is(err, source.ErrNotFound) {
			t.Errorf("service %q: %v", bad, err)
		}
	}
}

func mapRepo() fstest.MapFS {
	return fstest.MapFS{
		"services/hello/score.yaml":         {Data: []byte("apiVersion: score.dev/v1b1\nmetadata: {name: hello}\ncontainers: {main: {image: ghcr.io/example/hello:1.0.0}}\n")},
		"environments/dev/_defaults.yaml":   {Data: []byte("name: dev\n")},
		"services/renamed/score.yaml":       {Data: []byte("apiVersion: score.dev/v1b1\nmetadata: {name: other}\ncontainers: {main: {image: ghcr.io/example/hello:1.0.0}}\n")},
		"environments/wrong/_defaults.yaml": {Data: []byte("name: dev\n")},
		"services/Bad_Name/score.yaml":      {Data: []byte("x")},
		"services/big/score.yaml":           {Data: make([]byte, source.MaxFileSize+1)},
		"environments/dev/hello.score.yaml": {Data: []byte("containers: {main: {image: ghcr.io/example/hello:1.0.1}}\n")},
	}
}

// The in-memory source: the same reader over fstest.MapFS.
func TestMemorySource(t *testing.T) {
	ctx := context.Background()
	src := source.NewFS(mapRepo(), "v7")
	svcs, err := src.Services(ctx)
	if err == nil || !strings.Contains(err.Error(), "Bad_Name") || strings.Join(svcs, ",") != "big,hello,renamed" {
		t.Errorf("a folder that is not a DNS label is reported, not skipped: %v %v", svcs, err)
	}
	p := New(src)
	defer p.Close()
	plan, err := p.Build(ctx, "hello", "dev", Options{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Revision != "v7" || plan.Blocked() {
		t.Errorf("hello in dev: revision %q blocked %v %v", plan.Revision, plan.Blocked(), plan.Report.Findings)
	}
	if _, err := p.Build(ctx, "renamed", "dev", Options{}); err == nil || !strings.Contains(err.Error(), "must be the folder's name") {
		t.Errorf("metadata.name must match the folder: %v", err)
	}
	if _, err := p.Build(ctx, "hello", "wrong", Options{}); err == nil || !strings.Contains(err.Error(), `names environment "dev"`) {
		t.Errorf("an environment's defaults must name it: %v", err)
	}
	if _, err := p.Build(ctx, "big", "dev", Options{}); err == nil || !strings.Contains(err.Error(), "limit") {
		t.Errorf("a file above the size limit: %v", err)
	}
}

func TestGateCache(t *testing.T) {
	ctx := context.Background()
	fsys := mapRepo()
	p := New(source.NewFS(fsys, ""))
	defer p.Close()
	if _, err := p.Build(ctx, "hello", "dev", Options{}); err != nil {
		t.Fatal(err)
	}
	first := p.gates["dev"].gate
	if _, err := p.Build(ctx, "hello", "dev", Options{}); err != nil {
		t.Fatal(err)
	}
	if p.gates["dev"].gate != first {
		t.Error("the gate was built again with nothing changed")
	}
	fsys["policies/deny.rego"] = &fstest.MapFile{Data: []byte(`package kubeast.deploy

import rego.v1

finding contains f if {
	some obj in input.objects
	obj.kind == "Deployment"
	f := {"rule": "no-deployments", "kind": obj.kind, "name": obj.metadata.name, "msg": "no"}
}
`)}
	plan, err := p.Build(ctx, "hello", "dev", Options{})
	if err != nil {
		t.Fatal(err)
	}
	if p.gates["dev"].gate == first || !plan.Blocked() {
		t.Error("a new policy file must rebuild the gate and take effect")
	}
}

func TestConcurrentBuilds(t *testing.T) {
	p := repo(t)
	var wg sync.WaitGroup
	errs := make(chan error, 24)
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			env := []string{"alpha", "prod"}[i%2]
			svc := []string{"web", "api"}[i%3%2]
			if _, err := p.Build(context.Background(), svc, env, Options{}); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if len(p.gates) != 2 {
		t.Errorf("%d gates, want one per environment", len(p.gates))
	}
}

func BenchmarkBuild(b *testing.B) {
	p := repo(b)
	ctx := context.Background()
	if _, err := p.Build(ctx, "web", "prod", Options{}); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := p.Build(ctx, "web", "prod", Options{}); err != nil {
			b.Fatal(err)
		}
	}
}
