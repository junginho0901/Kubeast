package jobspec

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	sigsyaml "sigs.k8s.io/yaml"
)

func gitInput(t *testing.T) Input {
	t.Helper()
	for _, c := range readCases(t) {
		if c.Name == "default" {
			return caseInput(t, c)
		}
	}
	t.Fatal("no default case")
	return Input{}
}

func TestGitSecret(t *testing.T) {
	in := gitInput(t)
	if in.GitSecret != GitSecretName(in.Build.ID) {
		t.Fatalf("the default case mounts %q", in.GitSecret)
	}
	expires := time.Date(2026, 11, 1, 18, 30, 0, 0, time.FixedZone("KST", 9*3600))
	s, err := GitSecret(in, "ghs_0123456789abcdefABCDEF", expires)
	if err != nil {
		t.Fatal(err)
	}
	got, err := sigsyaml.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join("testdata", "git-secret.golden.yaml")
	if *update {
		if err := os.WriteFile(file, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(file)
	if err != nil || string(got) != string(want) {
		t.Fatalf("%s differs (%v); run go test ./internal/jobspec -update and read the diff\n%s", file, err, got)
	}
	res, err := Render(in)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s.Labels, res.Job.Labels) {
		t.Errorf("Secret labels %v, Job labels %v", s.Labels, res.Job.Labels)
	}
	if s.Annotations[ExpiresAnnotation] != "2026-11-01T09:30:00Z" || s.Immutable == nil || !*s.Immutable {
		t.Errorf("annotations %v immutable %v", s.Annotations, s.Immutable)
	}

	for name, tc := range map[string]struct {
		mutate  func(*Input)
		token   string
		expires time.Time
	}{
		"line break":    {token: "ghs_abc\nusername=evil"},
		"space":         {token: "ghs abc"},
		"empty":         {token: ""},
		"too long":      {token: strings.Repeat("a", 1025)},
		"not ASCII":     {token: "ghs_토큰"},
		"no expiry":     {token: "ghs_abc", expires: time.Time{}},
		"other secret":  {token: "ghs_abc", mutate: func(i *Input) { i.GitSecret = "shared-token" }},
		"no secret":     {token: "ghs_abc", mutate: func(i *Input) { i.GitSecret = "" }},
		"bad build id":  {token: "ghs_abc", mutate: func(i *Input) { i.Build.ID = "B1"; i.GitSecret = GitSecretName("B1") }},
		"bad namespace": {token: "ghs_abc", mutate: func(i *Input) { i.Namespace = "CI" }},
	} {
		in := gitInput(t)
		if tc.mutate != nil {
			tc.mutate(&in)
		}
		exp := expires
		if name == "no expiry" {
			exp = tc.expires
		}
		if _, err := GitSecret(in, tc.token, exp); err == nil {
			t.Errorf("%s: accepted", name)
		} else if strings.Contains(err.Error(), "ghs_") {
			t.Errorf("%s: the error shows the token: %v", name, err)
		}
	}
}

func TestWithOwner(t *testing.T) {
	in := gitInput(t)
	s, err := GitSecret(in, "ghs_abc", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	res, err := Render(in)
	if err != nil {
		t.Fatal(err)
	}
	job := res.Job.DeepCopy()
	if err := WithOwner(s, job); err == nil {
		t.Error("a Job without a UID became the owner")
	}
	job.UID = "4f1c2c55-6d0e-4b8e-9c38-0f3ad2b1c111"
	other := job.DeepCopy()
	other.Namespace = "elsewhere"
	if err := WithOwner(s, other); err == nil {
		t.Error("a Job in another namespace became the owner")
	}
	other = job.DeepCopy()
	other.Labels = map[string]string{"kubeast.io/ci-build": "b2"}
	if err := WithOwner(s, other); err == nil {
		t.Error("another build's Job became the owner")
	}
	if err := WithOwner(s, job); err != nil {
		t.Fatal(err)
	}
	o := s.OwnerReferences
	if len(o) != 1 || o[0].APIVersion != "batch/v1" || o[0].Kind != "Job" || o[0].Name != "ci-b1" || o[0].UID != job.UID {
		t.Fatalf("owner references %+v", o)
	}
	var _ *batchv1.Job = job
}
