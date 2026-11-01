// Package jobspec turns one build of a pipeline into the Kubernetes Job that
// runs it: one Job, one pod. The steps are init containers, which Kubernetes
// runs one after another and stops at the first that fails; Kubeast adds a
// checkout container before them and a report container after them, which
// writes the digests of the images built as the pod's termination message.
// The shape follows BuildKit's own Kubernetes Job examples
// (examples/kubernetes/job.rootless.yaml and job.privileged.yaml, v0.34.1).
package jobspec

import (
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/pipeline"
	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/runner"
)

// Build is the commit one build runs on.
type Build struct {
	// ID is the controller's name for the build; the Job is ci-<ID>.
	ID string
	// Repo is owner/name.
	Repo string
	// RepoURL is the http(s) URL to clone, without credentials.
	RepoURL string
	// CommitSHA is the full commit hash the build checks out.
	CommitSHA string
	// Ref is what started the build: refs/heads/…, refs/tags/… or the pull
	// request's head ref.
	Ref string
	// Event is push or pull_request.
	Event string
}

// Input is everything one render needs.
type Input struct {
	// Pipeline is parsed (pipeline.Parse) or normalized (Normalize).
	Pipeline  *pipeline.Pipeline
	Build     Build
	Namespace string
	// Profile is the runner profile the pipeline names.
	Profile runner.Profile
	Images  runner.Images
	// GitSecret, when set, is a Secret in Namespace whose key "token" the
	// checkout container uses to clone; no other container mounts it.
	GitSecret string
	// Secrets maps a pipeline's build secret names to Secrets in Namespace,
	// which the controller makes for this build. A registry secret is a
	// kubernetes.io/dockerconfigjson Secret.
	Secrets map[string]string
	// Untrusted marks a pull request from a fork that a maintainer approved:
	// no secret reaches its steps, the image is built but not pushed, and
	// its scan and deploy steps do not run (GitHub Actions' default for
	// forks).
	Untrusted bool
	// TTL is how long Kubernetes keeps the finished Job. Zero: one hour.
	TTL time.Duration
}

// Deploy is a deploy step the controller hands to the deploy module once
// the Job succeeded, with the digest the report container wrote.
type Deploy struct {
	Step    string
	From    string
	Image   string
	Service string
	Env     string
	Mode    string
}

// Result is the Job and what the controller does after it.
type Result struct {
	Job     *batchv1.Job
	Deploys []Deploy
	Notes   []string
}

// Paths inside the build pod.
const (
	WorkspaceDir = "/workspace"
	outDir       = "/kubeast/out"
	gitTokenDir  = "/run/kubeast/git"
	registryDir  = "/run/kubeast/registry"
	secretsDir   = "/run/secrets"
	buildUID     = 1000
)

var (
	idRe     = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	shaRe    = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)
	repoRe   = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	urlRe    = regexp.MustCompile(`^https?://[^/@\s]+/[^\s]+$`)
	refRe    = regexp.MustCompile(`^refs/[^\s]+$`)
	nsRe     = idRe
	sevAbove = map[string]string{
		"LOW":      "LOW,MEDIUM,HIGH,CRITICAL",
		"MEDIUM":   "MEDIUM,HIGH,CRITICAL",
		"HIGH":     "HIGH,CRITICAL",
		"CRITICAL": "CRITICAL",
	}
)

// Render builds the Job of one build. It refuses an input it cannot render
// exactly as asked rather than dropping a part of it.
func Render(in Input) (*Result, error) {
	if err := check(in); err != nil {
		return nil, err
	}
	p := in.Pipeline
	timeout, _ := pipeline.ParseTimeout(p.Timeout)
	if timeout > in.Profile.MaxTimeout {
		return nil, fmt.Errorf("timeout %s is above profile %s's limit of %s", p.Timeout, in.Profile.Name, in.Profile.MaxTimeout)
	}
	if err := missingSecrets(in); err != nil {
		return nil, err
	}
	r := &renderer{in: in, volumes: map[string]corev1.Volume{}}
	res := &Result{}

	inits := []corev1.Container{r.checkout()}
	var skipped []string
	for _, s := range p.Steps {
		switch {
		case s.Deploy != nil:
			if in.Untrusted {
				skipped = append(skipped, s.Name)
				continue
			}
			b := p.BuildStep(s.Deploy.From)
			res.Deploys = append(res.Deploys, Deploy{
				Step: s.Name, From: s.Deploy.From, Image: b.Image + ":" + in.Build.CommitSHA,
				Service: s.Deploy.Service, Env: s.Deploy.Env, Mode: s.Deploy.Mode,
			})
		case s.Scan != nil:
			if in.Untrusted {
				skipped = append(skipped, s.Name)
				continue
			}
			inits = append(inits, r.scan(s))
		case s.Build != nil:
			inits = append(inits, r.build(s))
		default:
			inits = append(inits, r.commands(s))
		}
	}
	if in.Untrusted {
		res.Notes = append(res.Notes, "a pull request from a fork: no build secret is mounted and images are built without being pushed")
		if len(skipped) > 0 {
			res.Notes = append(res.Notes, "steps that need the pushed image do not run: "+strings.Join(skipped, ", "))
		}
	}

	labels := buildLabels(in)
	annotations := map[string]string{
		"kubeast.io/ci-repo":   in.Build.Repo,
		"kubeast.io/ci-commit": in.Build.CommitSHA,
		"kubeast.io/ci-ref":    in.Build.Ref,
		"kubeast.io/ci-event":  in.Build.Event,
	}
	if in.Untrusted {
		annotations["kubeast.io/ci-untrusted"] = "true"
	}
	ttl := in.TTL
	if ttl == 0 {
		ttl = time.Hour
	}

	res.Job = &batchv1.Job{
		TypeMeta: metav1.TypeMeta{APIVersion: "batch/v1", Kind: "Job"},
		ObjectMeta: metav1.ObjectMeta{
			Name:        "ci-" + in.Build.ID,
			Namespace:   in.Namespace,
			Labels:      labels,
			Annotations: annotations,
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:            ptr(int32(0)),
			ActiveDeadlineSeconds:   ptr(int64(timeout / time.Second)),
			TTLSecondsAfterFinished: ptr(int32(ttl / time.Second)),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: copyMap(labels)},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: ptr(false),
					EnableServiceLinks:           ptr(false),
					NodeSelector:                 r.nodeSelector(),
					Tolerations:                  in.Profile.Tolerations,
					InitContainers:               inits,
					Containers:                   []corev1.Container{r.report()},
					Volumes:                      r.sortedVolumes(),
				},
			},
		},
	}
	return res, nil
}

func check(in Input) error {
	var errs []string
	add := func(format string, args ...any) { errs = append(errs, fmt.Sprintf(format, args...)) }
	if in.Pipeline == nil {
		return errors.New("no pipeline")
	}
	if err := in.Pipeline.Validate(); err != nil {
		return err
	}
	b := in.Build
	if len(b.ID) > 40 || !idRe.MatchString(b.ID) {
		add("build id %q is not a DNS label of at most 40 characters", b.ID)
	}
	if !repoRe.MatchString(b.Repo) {
		add("repo %q is not owner/name", b.Repo)
	}
	if !urlRe.MatchString(b.RepoURL) {
		add("repo URL must be http(s) without credentials")
	}
	if !shaRe.MatchString(b.CommitSHA) {
		add("commit %q is not a full commit hash", b.CommitSHA)
	}
	if !refRe.MatchString(b.Ref) {
		add("ref %q does not start with refs/", b.Ref)
	}
	if b.Event != "push" && b.Event != "pull_request" {
		add("event %q is not push or pull_request", b.Event)
	}
	if len(in.Namespace) > 63 || !nsRe.MatchString(in.Namespace) {
		add("namespace %q is not a DNS label", in.Namespace)
	}
	if in.Profile.Name != in.Pipeline.Profile {
		add("the pipeline asks for profile %q, the input is %q", in.Pipeline.Profile, in.Profile.Name)
	}
	if err := in.Profile.Validate(); err != nil {
		add("%v", err)
	}
	if err := in.Images.Validate(); err != nil {
		add("%v", err)
	}
	if in.Pipeline.Timeout == "" {
		add("the pipeline is not normalized (no timeout)")
	}
	for _, s := range in.Pipeline.Steps {
		if (s.Scan != nil && s.Scan.From == "") || (s.Deploy != nil && s.Deploy.From == "") || (s.Build != nil && s.Build.Context == "") {
			add("the pipeline is not normalized (step %s)", s.Name)
			break
		}
	}
	if len(errs) == 0 {
		return nil
	}
	sort.Strings(errs)
	return errors.New(strings.Join(errs, "; "))
}

// missingSecrets names the build secrets the pipeline uses that the input
// does not provide. An untrusted build mounts none, so it needs none.
func missingSecrets(in Input) error {
	if in.Untrusted {
		return nil
	}
	var missing []string
	need := func(name string) {
		if _, ok := in.Secrets[name]; !ok && !contains(missing, name) {
			missing = append(missing, name)
		}
	}
	for _, s := range in.Pipeline.Steps {
		for _, name := range s.Secrets {
			need(name)
		}
		if s.Build != nil && s.Build.RegistrySecret != "" {
			need(s.Build.RegistrySecret)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	sort.Strings(missing)
	return fmt.Errorf("build secrets not set for this repository: %s", strings.Join(missing, ", "))
}

type renderer struct {
	in      Input
	volumes map[string]corev1.Volume
}

func (r *renderer) volume(v corev1.Volume) {
	r.volumes[v.Name] = v
}

func (r *renderer) sortedVolumes() []corev1.Volume {
	names := make([]string, 0, len(r.volumes))
	for n := range r.volumes {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]corev1.Volume, 0, len(names))
	for _, n := range names {
		out = append(out, r.volumes[n])
	}
	return out
}

func (r *renderer) emptyDir(name string) {
	r.volume(corev1.Volume{Name: name, VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}})
}

func (r *renderer) nodeSelector() map[string]string {
	p := r.in.Profile
	sel := copyMap(p.NodeSelector)
	sel["kubernetes.io/arch"] = p.Arch
	if p.CapacityType != "" {
		sel["karpenter.sh/capacity-type"] = p.CapacityType
	}
	return sel
}

// resources gives every container the profile's size. Init containers run
// one at a time, so the pod's request is one step's (the largest of them).
func (r *renderer) resources() corev1.ResourceRequirements {
	p := r.in.Profile
	req := corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse(p.CPU),
		corev1.ResourceMemory: resource.MustParse(p.Memory),
	}
	lim := corev1.ResourceList{corev1.ResourceMemory: resource.MustParse(p.Memory)}
	if p.EphemeralStorage != "" {
		req[corev1.ResourceEphemeralStorage] = resource.MustParse(p.EphemeralStorage)
		lim[corev1.ResourceEphemeralStorage] = resource.MustParse(p.EphemeralStorage)
	}
	return corev1.ResourceRequirements{Requests: req, Limits: lim}
}

// hardened is the security context of the containers Kubeast writes: the
// Pod Security "restricted" profile.
func hardened() *corev1.SecurityContext {
	return &corev1.SecurityContext{
		RunAsUser:                ptr(int64(buildUID)),
		RunAsGroup:               ptr(int64(buildUID)),
		RunAsNonRoot:             ptr(true),
		AllowPrivilegeEscalation: ptr(false),
		ReadOnlyRootFilesystem:   ptr(true),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
	}
}

// stepSecurity is the security context of a commands or scan step: the
// image's own user, without privilege escalation, under the runtime's
// default seccomp profile.
func stepSecurity() *corev1.SecurityContext {
	return &corev1.SecurityContext{
		AllowPrivilegeEscalation: ptr(false),
		SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
	}
}

// checkoutScript clones one commit. The values come from the environment;
// nothing from the pipeline or the event is written into the script.
const checkoutScript = `git init -q /workspace
cd /workspace
git remote add origin "$KUBEAST_REPO_URL"
git fetch -q --no-tags --depth=1 origin "$KUBEAST_COMMIT_SHA"
git checkout -q --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$KUBEAST_COMMIT_SHA"
`

// checkoutTokenScript is checkoutScript with the token read from the
// mounted file by a credential helper, so it is in no argument or variable.
const checkoutTokenScript = `git init -q /workspace
cd /workspace
git remote add origin "$KUBEAST_REPO_URL"
git -c credential.helper= -c 'credential.helper=!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$(cat /run/kubeast/git/token)"; }; f' fetch -q --no-tags --depth=1 origin "$KUBEAST_COMMIT_SHA"
git checkout -q --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$KUBEAST_COMMIT_SHA"
`

func (r *renderer) checkout() corev1.Container {
	r.emptyDir("workspace")
	r.emptyDir("tmp")
	script := checkoutScript
	mounts := []corev1.VolumeMount{
		{Name: "workspace", MountPath: WorkspaceDir},
		{Name: "tmp", MountPath: "/tmp"},
	}
	if r.in.GitSecret != "" {
		script = checkoutTokenScript
		r.volume(corev1.Volume{Name: "git-token", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
			SecretName: r.in.GitSecret,
			Items:      []corev1.KeyToPath{{Key: "token", Path: "token"}},
		}}})
		mounts = append(mounts, corev1.VolumeMount{Name: "git-token", MountPath: gitTokenDir, ReadOnly: true})
	}
	return corev1.Container{
		Name:    "checkout",
		Image:   r.in.Images.Git,
		Command: []string{"/bin/sh", "-e", "-c", script},
		Env: []corev1.EnvVar{
			{Name: "GIT_CONFIG_COUNT", Value: "1"},
			{Name: "GIT_CONFIG_KEY_0", Value: "safe.directory"},
			{Name: "GIT_CONFIG_VALUE_0", Value: WorkspaceDir},
			{Name: "GIT_TERMINAL_PROMPT", Value: "0"},
			{Name: "HOME", Value: "/tmp"},
			{Name: "KUBEAST_COMMIT_SHA", Value: r.in.Build.CommitSHA},
			{Name: "KUBEAST_REPO_URL", Value: r.in.Build.RepoURL},
		},
		Resources:       r.resources(),
		SecurityContext: hardened(),
		VolumeMounts:    mounts,
	}
}

// reportScript writes "<build step>=<digest>" per image built, from the
// metadata files BuildKit wrote, as the termination message (and in the
// log, which the controller reads when the message is missing).
const reportScript = `for f in /kubeast/out/*.json; do
  [ -e "$f" ] || continue
  printf '%s=%s\n' "$(basename "$f" .json)" "$(sed -n 's/^ *"containerimage.digest": *"\(sha256:[0-9a-f]*\)".*/\1/p' "$f")"
done > /tmp/result
cat /tmp/result
cat /tmp/result 2>/dev/null >/dev/termination-log || echo "kubeast: the termination log is not writable; the result is in the log above" >&2
`

func (r *renderer) report() corev1.Container {
	r.emptyDir("out")
	return corev1.Container{
		Name:            "report",
		Image:           r.in.Images.Git,
		Command:         []string{"/bin/sh", "-e", "-c", reportScript},
		Resources:       r.resources(),
		SecurityContext: hardened(),
		VolumeMounts: []corev1.VolumeMount{
			{Name: "out", MountPath: outDir, ReadOnly: true},
			{Name: "tmp", MountPath: "/tmp"},
		},
	}
}

// stepEnv is what every commands step sees: CI=true, the build's facts,
// then the pipeline's env and the step's (the step wins), by name.
func (r *renderer) stepEnv(s pipeline.Step) []corev1.EnvVar {
	b := r.in.Build
	env := []corev1.EnvVar{
		{Name: "CI", Value: "true"},
		{Name: "KUBEAST_BUILD_ID", Value: b.ID},
		{Name: "KUBEAST_COMMIT_SHA", Value: b.CommitSHA},
		{Name: "KUBEAST_EVENT", Value: b.Event},
		{Name: "KUBEAST_REF", Value: b.Ref},
		{Name: "KUBEAST_REPO", Value: b.Repo},
	}
	merged := copyMap(r.in.Pipeline.Env)
	for k, v := range s.Env {
		merged[k] = v
	}
	for _, k := range sortedKeys(merged) {
		env = append(env, corev1.EnvVar{Name: k, Value: merged[k]})
	}
	return env
}

func (r *renderer) commands(s pipeline.Step) corev1.Container {
	mounts := []corev1.VolumeMount{{Name: "workspace", MountPath: WorkspaceDir}}
	if !r.in.Untrusted {
		for _, name := range s.Secrets {
			vol := "sec-" + name
			r.volume(corev1.Volume{Name: vol, VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: r.in.Secrets[name]}}})
			mounts = append(mounts, corev1.VolumeMount{Name: vol, MountPath: path.Join(secretsDir, name), ReadOnly: true})
		}
	}
	return corev1.Container{
		Name:            s.Name,
		Image:           s.Image,
		Command:         []string{"/bin/sh", "-e", "-c", strings.Join(s.Commands, "\n")},
		WorkingDir:      WorkspaceDir,
		Env:             r.stepEnv(s),
		Resources:       r.resources(),
		SecurityContext: stepSecurity(),
		VolumeMounts:    mounts,
	}
}

// registry mounts a registry secret's Docker config and returns the
// DOCKER_CONFIG directory, or "" for none (or an untrusted build).
func (r *renderer) registry(name string) (string, *corev1.VolumeMount) {
	if name == "" || r.in.Untrusted {
		return "", nil
	}
	vol := "reg-" + name
	r.volume(corev1.Volume{Name: vol, VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
		SecretName: r.in.Secrets[name],
		Items:      []corev1.KeyToPath{{Key: corev1.DockerConfigJsonKey, Path: "config.json"}},
	}}})
	dir := path.Join(registryDir, name)
	return dir, &corev1.VolumeMount{Name: vol, MountPath: dir, ReadOnly: true}
}

func (r *renderer) build(s pipeline.Step) corev1.Container {
	b := s.Build
	r.emptyDir("buildkitd")
	r.emptyDir("out")
	push := !r.in.Untrusted
	ref := b.Image + ":" + r.in.Build.CommitSHA
	args := []string{
		"build",
		"--frontend", "dockerfile.v0",
		"--local", "context=" + path.Join(WorkspaceDir, b.Context),
		"--local", "dockerfile=" + path.Join(WorkspaceDir, path.Dir(b.Dockerfile)),
		"--opt", "filename=" + path.Base(b.Dockerfile),
	}
	if b.Target != "" {
		args = append(args, "--opt", "target="+b.Target)
	}
	for _, k := range sortedKeys(b.Args) {
		args = append(args, "--opt", "build-arg:"+k+"="+b.Args[k])
	}
	args = append(args, "--output", fmt.Sprintf("type=image,name=%s,push=%t", ref, push))
	if push {
		cache := b.Image + ":buildcache"
		args = append(args,
			"--export-cache", "type=registry,ref="+cache+",mode=max",
			"--import-cache", "type=registry,ref="+cache)
	}
	args = append(args, "--metadata-file", path.Join(outDir, s.Name+".json"))

	stateDir := "/home/user/.local/share/buildkit"
	image := r.in.Images.BuildKitRootless
	var env []corev1.EnvVar
	sc := &corev1.SecurityContext{
		RunAsUser:       ptr(int64(buildUID)),
		RunAsGroup:      ptr(int64(buildUID)),
		SeccompProfile:  &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeUnconfined},
		AppArmorProfile: &corev1.AppArmorProfile{Type: corev1.AppArmorProfileTypeUnconfined},
	}
	if r.in.Profile.Engine == runner.EngineRootless {
		env = append(env, corev1.EnvVar{Name: "BUILDKITD_FLAGS", Value: "--oci-worker-no-process-sandbox"})
	} else {
		stateDir = "/var/lib/buildkit"
		image = r.in.Images.BuildKit
		sc = &corev1.SecurityContext{Privileged: ptr(true)}
	}
	mounts := []corev1.VolumeMount{
		{Name: "workspace", MountPath: WorkspaceDir, ReadOnly: true},
		{Name: "buildkitd", MountPath: stateDir},
		{Name: "out", MountPath: outDir},
	}
	if dir, m := r.registry(b.RegistrySecret); m != nil {
		env = append(env, corev1.EnvVar{Name: "DOCKER_CONFIG", Value: dir})
		mounts = append(mounts, *m)
	}
	return corev1.Container{
		Name:            s.Name,
		Image:           image,
		Command:         []string{"buildctl-daemonless.sh"},
		Args:            args,
		Env:             env,
		Resources:       r.resources(),
		SecurityContext: sc,
		VolumeMounts:    mounts,
	}
}

func (r *renderer) scan(s pipeline.Step) corev1.Container {
	b := r.in.Pipeline.BuildStep(s.Scan.From)
	args := []string{"image", "--exit-code", "1", "--severity", sevAbove[s.Scan.Severity], "--no-progress", "--image-src", "remote"}
	if repos := r.in.Images.TrivyDBRepositories; len(repos) > 0 {
		args = append(args, "--db-repository", strings.Join(repos, ","))
	}
	args = append(args, b.Image+":"+r.in.Build.CommitSHA)
	var env []corev1.EnvVar
	var mounts []corev1.VolumeMount
	if dir, m := r.registry(b.RegistrySecret); m != nil {
		env = append(env, corev1.EnvVar{Name: "DOCKER_CONFIG", Value: dir})
		mounts = append(mounts, *m)
	}
	return corev1.Container{
		Name:            s.Name,
		Image:           r.in.Images.Trivy,
		Command:         []string{"trivy"},
		Args:            args,
		Env:             env,
		Resources:       r.resources(),
		SecurityContext: stepSecurity(),
		VolumeMounts:    mounts,
	}
}

// buildLabels are on a build's Job, its pod and its git Secret.
func buildLabels(in Input) map[string]string {
	return map[string]string{
		"app.kubernetes.io/managed-by": "kubeast",
		"app.kubernetes.io/component":  "ci-build",
		"kubeast.io/ci-build":          in.Build.ID,
		"kubeast.io/ci-profile":        in.Profile.Name,
	}
}

func ptr[T any](v T) *T { return &v }

func copyMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
