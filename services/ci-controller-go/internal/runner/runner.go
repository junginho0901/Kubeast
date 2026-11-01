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

// DefaultProfile is the profile named "default": the values of the company
// CI runner design (P13) — 2 CPU and 8 GiB per build, amd64, on-demand.
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

// DefaultImages are the newest releases on 2026-11-01: alpine/git v2.54.0
// (2026-10-25), BuildKit v0.34.1 (2026-10-20), Trivy 0.76.1 (2026-10-21).
func DefaultImages() Images {
	return Images{
		Git:              "docker.io/alpine/git:v2.54.0",
		BuildKit:         "docker.io/moby/buildkit:v0.34.1",
		BuildKitRootless: "docker.io/moby/buildkit:v0.34.1-rootless",
		Trivy:            "docker.io/aquasec/trivy:0.76.1",
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
