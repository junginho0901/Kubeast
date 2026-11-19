// Package runner holds what an installer sets for build pods: the runner
// profiles a pipeline picks from and the images of the steps Kubeast adds.
// The fields follow ARC's runner templates, Tekton's podTemplate and GitLab
// Runner's node_selector: placement, size, architecture and build engine.
package runner

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

// Engines build images with BuildKit.
const (
	// EngineRootless runs moby/buildkit's rootless image as UID 1000. It
	// still needs seccomp and AppArmor unconfined (BuildKit's rootless
	// documentation), so the build namespace is Pod Security "privileged".
	EngineRootless = "rootless"
	// EnginePrivileged runs BuildKit as root in a privileged container, for
	// nodes where rootless does not work.
	EnginePrivileged = "privileged"
)

// Profile is a kind of build pod.
type Profile struct {
	Name string `json:"name"`
	// Arch is amd64 or arm64 (the node label kubernetes.io/arch).
	Arch string `json:"arch"`
	// CPU and Memory are each step's requests; Memory is also its limit.
	// Steps run one at a time, so the pod asks for one step's worth.
	CPU    string `json:"cpu"`
	Memory string `json:"memory"`
	// EphemeralStorage, when set, is each step's request and limit of
	// node disk (the workspace and image layers live there).
	EphemeralStorage string `json:"ephemeralStorage,omitempty"`
	Engine           string `json:"engine"`
	// CapacityType, when set, is on-demand or spot (Karpenter's
	// karpenter.sh/capacity-type label).
	CapacityType string              `json:"capacityType,omitempty"`
	NodeSelector map[string]string   `json:"nodeSelector,omitempty"`
	Tolerations  []corev1.Toleration `json:"tolerations,omitempty"`
	// MaxTimeout caps a pipeline's timeout on this profile.
	MaxTimeout time.Duration `json:"maxTimeout"`
}

// DefaultProfile is the profile named "default": 2 CPU and 8 GiB per build on
// amd64, the size of GitHub's standard hosted Linux runner for private
// repositories, on on-demand nodes, since a reclaimed spot node ends the build.
func DefaultProfile() Profile {
	return Profile{
		Name:         "default",
		Arch:         "amd64",
		CPU:          "2",
		Memory:       "8Gi",
		Engine:       EngineRootless,
		CapacityType: "on-demand",
		MaxTimeout:   2 * time.Hour,
	}
}

var nameRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// Validate checks a profile and returns every problem.
func (p Profile) Validate() error {
	var errs []string
	add := func(format string, args ...any) { errs = append(errs, fmt.Sprintf(format, args...)) }
	if len(p.Name) > 63 || !nameRe.MatchString(p.Name) {
		add("name %q is not a DNS label", p.Name)
	}
	if p.Arch != "amd64" && p.Arch != "arm64" {
		add("arch must be amd64 or arm64")
	}
	for field, q := range map[string]string{"cpu": p.CPU, "memory": p.Memory, "ephemeralStorage": p.EphemeralStorage} {
		if q == "" && field == "ephemeralStorage" {
			continue
		}
		v, err := resource.ParseQuantity(q)
		if err != nil || v.Sign() <= 0 {
			add("%s %q is not a positive quantity", field, q)
		}
	}
	if p.Engine != EngineRootless && p.Engine != EnginePrivileged {
		add("engine must be %s or %s", EngineRootless, EnginePrivileged)
	}
	if p.CapacityType != "" && p.CapacityType != "on-demand" && p.CapacityType != "spot" {
		add("capacityType must be on-demand or spot")
	}
	for k := range p.NodeSelector {
		if k == "kubernetes.io/arch" || (k == "karpenter.sh/capacity-type" && p.CapacityType != "") {
			add("nodeSelector %s comes from the profile's own field", k)
		}
	}
	if p.MaxTimeout <= 0 {
		add("maxTimeout must be positive")
	}
	if len(errs) == 0 {
		return nil
	}
	sort.Strings(errs)
	return fmt.Errorf("profile %s: %s", p.Name, strings.Join(errs, "; "))
}

// Images are the images of the steps Kubeast adds, by full reference. An
// installer points them at a mirror for an internal network.
type Images struct {
	// Git runs the checkout and report containers (it has git and sh).
	Git string `json:"git"`
	// BuildKit is moby/buildkit's root image (engine privileged);
	// BuildKitRootless its -rootless image (engine rootless).
	BuildKit         string `json:"buildkit"`
	BuildKitRootless string `json:"buildkitRootless"`
	Trivy            string `json:"trivy"`
	// TrivyDBRepositories, when set, replace Trivy's default vulnerability
	// database locations (mirror.gcr.io, ghcr.io), for internal networks.
	TrivyDBRepositories []string `json:"trivyDBRepositories,omitempty"`
}

// DefaultImages are pinned by tag and by the digest the tag named on
// 2026-11-19: the multi-platform index, so amd64 and arm64 profiles run the
// same build. alpine/git rebuilds its tags every week, so the tag alone moves.
// A new release changes the tag and the digest together;
// deploy/dependencies.yaml checks that these lines name its versions and
// looks upstream for newer releases every week.
//   - alpine/git v2.54.0 (git 2.54.0; the tag as rebuilt on 2026-11-08):
//     https://hub.docker.com/r/alpine/git
//   - BuildKit v0.34.1 (2026-10-20):
//     https://github.com/moby/buildkit/releases/tag/v0.34.1
//   - Trivy 0.76.1 (2026-10-21):
//     https://github.com/aquasecurity/trivy/releases/tag/v0.76.1
func DefaultImages() Images {
	return Images{
		Git:              "docker.io/alpine/git:v2.54.0@sha256:6a1fdb962814ca11508ca8d1bab94375b5b7ac4e4a9a40981c29fc32c02f095d",
		BuildKit:         "docker.io/moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c",
		BuildKitRootless: "docker.io/moby/buildkit:v0.34.1-rootless@sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89",
		Trivy:            "docker.io/aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c",
	}
}

// Validate checks that every image is set.
func (im Images) Validate() error {
	var missing []string
	for name, ref := range map[string]string{"git": im.Git, "buildkit": im.BuildKit, "buildkitRootless": im.BuildKitRootless, "trivy": im.Trivy} {
		if ref == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	sort.Strings(missing)
	return errors.New("images: " + strings.Join(missing, ", ") + " not set")
}
