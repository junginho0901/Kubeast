package jobspec

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
	corev1 "k8s.io/api/core/v1"
	sigsyaml "sigs.k8s.io/yaml"

	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/pipeline"
	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/runner"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden.yaml")

type testCase struct {
	Name     string `yaml:"name"`
	Pipeline string `yaml:"pipeline"`
	Default  *struct {
		Image          string `yaml:"image"`
		RegistrySecret string `yaml:"registrySecret"`
	} `yaml:"default"`
	Profile   string            `yaml:"profile"`
	Secrets   map[string]string `yaml:"secrets"`
	GitSecret string            `yaml:"gitSecret"`
	Untrusted bool              `yaml:"untrusted"`
	ID        string            `yaml:"id"`
	SHA       string            `yaml:"sha"`
	Ref       string            `yaml:"ref"`
	Event     string            `yaml:"event"`
	RepoURL   string            `yaml:"repoURL"`
	Namespace string            `yaml:"namespace"`
	Error     []string          `yaml:"error"`
}

// profiles are the installer's profiles the cases pick from.
var profiles = map[string]runner.Profile{
	"default": runner.DefaultProfile(),
	"arm64-spot": {
		Name: "arm64-spot", Arch: "arm64", CPU: "4", Memory: "16Gi", EphemeralStorage: "50Gi",
		Engine: runner.EnginePrivileged, CapacityType: "spot",
		NodeSelector: map[string]string{"kubeast.io/pool": "ci"},
		Tolerations:  []corev1.Toleration{{Key: "kubeast.io/ci", Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoSchedule}},
		MaxTimeout:   time.Hour,
	},
	"arm64-spot-short": {
		Name: "arm64-spot", Arch: "arm64", CPU: "4", Memory: "16Gi",
		Engine: runner.EnginePrivileged, MaxTimeout: 30 * time.Minute,
	},
}

func readCases(t testing.TB) []testCase {
	t.Helper()
	data, err := os.ReadFile("testdata/cases.yaml")
	if err != nil {
		t.Fatal(err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var cases []testCase
	if err := dec.Decode(&cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func or(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func caseInput(t testing.TB, c testCase) Input {
	t.Helper()
	var p *pipeline.Pipeline
	if c.Default != nil {
		p = pipeline.Default(c.Default.Image, c.Default.RegistrySecret)
		if err := p.Normalize(); err != nil {
			t.Fatal(err)
		}
	} else {
		data, err := os.ReadFile(filepath.Join("testdata", c.Pipeline))
		if err != nil {
			t.Fatal(err)
		}
		if p, err = pipeline.Parse(data); err != nil {
			t.Fatal(err)
		}
	}
	return Input{
		Pipeline: p,
		Build: Build{
			ID:        or(c.ID, "b1"),
			Repo:      "example/web",
			RepoURL:   or(c.RepoURL, "https://github.com/example/web.git"),
			CommitSHA: or(c.SHA, "0123456789abcdef0123456789abcdef01234567"),
			Ref:       or(c.Ref, "refs/heads/main"),
			Event:     or(c.Event, "push"),
		},
		Namespace: or(c.Namespace, "ci-builds"),
		Profile:   profiles[or(c.Profile, "default")],
		Images:    runner.DefaultImages(),
		GitSecret: c.GitSecret,
		Secrets:   c.Secrets,
		Untrusted: c.Untrusted,
	}
}

// golden is what a golden file holds: the deploys and notes as comments,
// then the Job.
func golden(t testing.TB, res *Result) []byte {
	t.Helper()
	var b bytes.Buffer
	for _, d := range res.Deploys {
		fmt.Fprintf(&b, "# deploy: step %s, %s/%s %s, image %s (from %s)\n", d.Step, d.Service, d.Env, d.Mode, d.Image, d.From)
	}
	for _, n := range res.Notes {
		fmt.Fprintf(&b, "# note: %s\n", n)
	}
	out, err := sigsyaml.Marshal(res.Job)
	if err != nil {
		t.Fatal(err)
	}
	b.Write(out)
	return b.Bytes()
}

func TestRenderCases(t *testing.T) {
	for _, c := range readCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			res, err := Render(caseInput(t, c))
			if len(c.Error) > 0 {
				if err == nil {
					t.Fatalf("Render accepted it, want %q", c.Error)
				}
				for _, want := range c.Error {
					if !strings.Contains(err.Error(), want) {
						t.Errorf("error %q\nwant it to contain %q", err, want)
					}
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := golden(t, res)
			file := filepath.Join("testdata", c.Name+".golden.yaml")
			if *update {
				if err := os.WriteFile(file, got, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("%s differs; run go test ./internal/jobspec -update and read the diff\n%s", file, got)
			}
		})
	}
}

// renderAll renders every case that renders, for the invariants below.
func renderAll(t *testing.T) map[string]*Result {
	t.Helper()
	out := map[string]*Result{}
	for _, c := range readCases(t) {
		if len(c.Error) > 0 {
			continue
		}
		res, err := Render(caseInput(t, c))
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		out[c.Name] = res
	}
	return out
}

func TestSameInputSameBytes(t *testing.T) {
	for _, c := range readCases(t) {
		if len(c.Error) > 0 {
			continue
		}
		first, err := Render(caseInput(t, c))
		if err != nil {
			t.Fatal(err)
		}
		want := golden(t, first)
		for i := 0; i < 20; i++ {
			res, _ := Render(caseInput(t, c))
			if !bytes.Equal(golden(t, res), want) {
				t.Fatalf("%s: render %d differs from the first", c.Name, i)
			}
		}
	}
}

// TestJobShape checks what every build Job must be, whatever the pipeline:
// one try, no service account token, checkout first and report last, the
// steps in the pipeline's order.
func TestJobShape(t *testing.T) {
	for name, res := range renderAll(t) {
		j := res.Job
		spec := j.Spec.Template.Spec
		switch {
		case j.Spec.BackoffLimit == nil || *j.Spec.BackoffLimit != 0:
			t.Errorf("%s: backoffLimit is not 0", name)
		case j.Spec.ActiveDeadlineSeconds == nil || j.Spec.TTLSecondsAfterFinished == nil:
			t.Errorf("%s: no deadline or TTL", name)
		case spec.RestartPolicy != corev1.RestartPolicyNever:
			t.Errorf("%s: restartPolicy %s", name, spec.RestartPolicy)
		case spec.AutomountServiceAccountToken == nil || *spec.AutomountServiceAccountToken:
			t.Errorf("%s: the service account token is mounted", name)
		case spec.InitContainers[0].Name != "checkout":
			t.Errorf("%s: first container is %s", name, spec.InitContainers[0].Name)
		case len(spec.Containers) != 1 || spec.Containers[0].Name != "report":
			t.Errorf("%s: containers are not [report]", name)
		}
	}
}

// TestSecretsReachOnlyTheirStep: the clone token only in checkout, a build
// secret only in the steps that name it, and nothing in a fork's build.
func TestSecretsReachOnlyTheirStep(t *testing.T) {
	for name, res := range renderAll(t) {
		spec := res.Job.Spec.Template.Spec
		secretVolumes := map[string]bool{}
		for _, v := range spec.Volumes {
			if v.Secret != nil {
				secretVolumes[v.Name] = true
			}
		}
		untrusted := res.Job.Annotations["kubeast.io/ci-untrusted"] == "true"
		for _, c := range append(append([]corev1.Container{}, spec.InitContainers...), spec.Containers...) {
			for _, m := range c.VolumeMounts {
				if !secretVolumes[m.Name] {
					continue
				}
				switch {
				case m.Name == "git-token" && c.Name != "checkout":
					t.Errorf("%s: %s mounts the clone token", name, c.Name)
				case m.Name != "git-token" && untrusted:
					t.Errorf("%s: fork build mounts %s in %s", name, m.Name, c.Name)
				case strings.HasPrefix(m.Name, "sec-") && !asked(c.Name, strings.TrimPrefix(m.Name, "sec-")):
					t.Errorf("%s: %s mounts %s it did not ask for", name, c.Name, m.Name)
				}
			}
			for _, e := range c.Env {
				if e.ValueFrom != nil {
					t.Errorf("%s: %s takes %s from a reference; secrets are files", name, c.Name, e.Name)
				}
			}
		}
		if untrusted {
			for _, v := range spec.Volumes {
				if v.Secret != nil && v.Name != "git-token" {
					t.Errorf("%s: fork build has secret volume %s", name, v.Name)
				}
			}
			for _, c := range spec.InitContainers {
				if strings.Contains(strings.Join(c.Args, " "), "push=true") {
					t.Errorf("%s: fork build pushes in %s", name, c.Name)
				}
			}
			if len(res.Deploys) > 0 {
				t.Errorf("%s: fork build deploys", name)
			}
		}
	}
}

// stepSecrets is filled by TestMain from the case pipelines: step name ->
// the secrets it lists (step names do not clash across the test pipelines).
var stepSecrets = map[string][]string{}

func asked(container, secret string) bool {
	for _, s := range stepSecrets[container] {
		if s == secret {
			return true
		}
	}
	return false
}

func TestMain(m *testing.M) {
	for _, f := range []string{"full.pipeline.yaml", "two-images.pipeline.yaml", "commands-only.pipeline.yaml"} {
		data, err := os.ReadFile(filepath.Join("testdata", f))
		if err != nil {
			panic(err)
		}
		p, err := pipeline.Parse(data)
		if err != nil {
			panic(err)
		}
		for _, s := range p.Steps {
			stepSecrets[s.Name] = append(stepSecrets[s.Name], s.Secrets...)
		}
	}
	os.Exit(m.Run())
}

// TestKubeastContainersAreRestricted: checkout and report meet the Pod
// Security "restricted" profile, and their scripts carry no value from the
// pipeline or the event (those come in as variables).
func TestKubeastContainersAreRestricted(t *testing.T) {
	for name, res := range renderAll(t) {
		spec := res.Job.Spec.Template.Spec
		for _, c := range []corev1.Container{spec.InitContainers[0], spec.Containers[0]} {
			sc := c.SecurityContext
			if sc == nil || sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot || sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation ||
				sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem || sc.Capabilities == nil || len(sc.Capabilities.Drop) != 1 ||
				sc.SeccompProfile == nil || sc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
				t.Errorf("%s: %s is not restricted: %+v", name, c.Name, sc)
			}
			script := c.Command[len(c.Command)-1]
			if script != checkoutScript && script != checkoutTokenScript && script != reportScript {
				t.Errorf("%s: %s runs a script that is not one of the fixed ones", name, c.Name)
			}
		}
	}
}

// TestBuildMatchesBuildKitExample: the rootless build container keeps what
// BuildKit's job.rootless.yaml sets, the privileged one job.privileged.yaml.
func TestBuildMatchesBuildKitExample(t *testing.T) {
	res := renderAll(t)
	full := res["full"].Job.Spec.Template.Spec.InitContainers
	var rootless, privileged *corev1.Container
	for i := range full {
		if full[i].Name == "image" {
			rootless = &full[i]
		}
	}
	for _, c := range res["two-images-privileged-arm64"].Job.Spec.Template.Spec.InitContainers {
		if c.Name == "api" {
			c := c
			privileged = &c
		}
	}
	if rootless == nil || privileged == nil {
		t.Fatal("build containers not found")
	}
	sc := rootless.SecurityContext
	if *sc.RunAsUser != 1000 || *sc.RunAsGroup != 1000 || sc.SeccompProfile.Type != corev1.SeccompProfileTypeUnconfined ||
		sc.AppArmorProfile.Type != corev1.AppArmorProfileTypeUnconfined || sc.Privileged != nil {
		t.Errorf("rootless security context %+v", sc)
	}
	b, _ := json.Marshal(rootless.Env)
	if !strings.Contains(string(b), `"BUILDKITD_FLAGS","value":"--oci-worker-no-process-sandbox"`) {
		t.Errorf("rootless env %s", b)
	}
	if !strings.HasSuffix(rootless.Image, "-rootless") || strings.HasSuffix(privileged.Image, "-rootless") {
		t.Errorf("images %s, %s", rootless.Image, privileged.Image)
	}
	if privileged.SecurityContext.Privileged == nil || !*privileged.SecurityContext.Privileged {
		t.Errorf("privileged security context %+v", privileged.SecurityContext)
	}
	for _, c := range []*corev1.Container{rootless, privileged} {
		if c.Command[0] != "buildctl-daemonless.sh" || c.Args[0] != "build" {
			t.Errorf("%s runs %v %v", c.Name, c.Command, c.Args[:1])
		}
		for _, m := range c.VolumeMounts {
			if m.Name == "workspace" && !m.ReadOnly {
				t.Errorf("%s mounts the workspace writable", c.Name)
			}
		}
	}
}
