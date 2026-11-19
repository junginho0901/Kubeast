package runner

import (
	"regexp"
	"strings"
	"testing"
)

func TestDefaults(t *testing.T) {
	if err := DefaultProfile().Validate(); err != nil {
		t.Fatal(err)
	}
	if err := DefaultImages().Validate(); err != nil {
		t.Fatal(err)
	}
}

// A new release keeps the digest beside the tag.
func TestDefaultImagesArePinnedByTagAndDigest(t *testing.T) {
	pinned := regexp.MustCompile(`^docker\.io/[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$`)
	im := DefaultImages()
	for name, ref := range map[string]string{"git": im.Git, "buildkit": im.BuildKit, "buildkitRootless": im.BuildKitRootless, "trivy": im.Trivy} {
		if !pinned.MatchString(ref) {
			t.Errorf("%s = %q, want <name>:<tag>@sha256:<digest>", name, ref)
		}
	}
}

func TestProfileProblems(t *testing.T) {
	p := Profile{
		Name: "Big", Arch: "x86", CPU: "0", Memory: "lots", EphemeralStorage: "-1Gi",
		Engine: "dind", CapacityType: "reserved",
		NodeSelector: map[string]string{"kubernetes.io/arch": "amd64"},
	}
	err := p.Validate()
	if err == nil {
		t.Fatal("accepted")
	}
	for _, want := range []string{
		`name "Big" is not a DNS label`,
		"arch must be amd64 or arm64",
		`cpu "0" is not a positive quantity`,
		`memory "lots" is not a positive quantity`,
		`ephemeralStorage "-1Gi" is not a positive quantity`,
		"engine must be rootless or privileged",
		"capacityType must be on-demand or spot",
		"nodeSelector kubernetes.io/arch comes from the profile's own field",
		"maxTimeout must be positive",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q\nwant %q", err, want)
		}
	}
}

func TestImagesMissing(t *testing.T) {
	err := Images{Git: "x"}.Validate()
	if err == nil || !strings.Contains(err.Error(), "buildkit, buildkitRootless, trivy not set") {
		t.Fatalf("err = %v", err)
	}
}
