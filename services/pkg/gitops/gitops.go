// Package gitops tells whether a Kubernetes object is managed by an Argo CD
// Application, from the marks Argo CD leaves on the object: the
// argocd.argoproj.io/tracking-id annotation ("app:group/Kind:namespace/name",
// the default since Argo CD 2.x) or, when configured, the instance label.
package gitops

import (
	"strings"

	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
)

const (
	ModeWarn  = "warn"
	ModeBlock = "block"

	DefaultTrackingAnnotation = "argocd.argoproj.io/tracking-id"
)

// Config comes from the chart's gitops.argocd values (GITOPS_ARGOCD_* env).
type Config struct {
	Enabled            bool
	Mode               string // warn | block
	TrackingAnnotation string
	InstanceLabel      string // empty = label tracking off
	URL                string // Argo CD UI, for the badge link
}

func LoadFromEnv() Config {
	mode := strings.ToLower(pkgconfig.GetEnv("GITOPS_ARGOCD_MODE", ModeWarn))
	if mode != ModeBlock {
		mode = ModeWarn
	}
	return Config{
		Enabled:            pkgconfig.GetEnvBool("GITOPS_ARGOCD_ENABLED", false),
		Mode:               mode,
		TrackingAnnotation: pkgconfig.GetEnv("GITOPS_ARGOCD_TRACKING_ANNOTATION", DefaultTrackingAnnotation),
		InstanceLabel:      pkgconfig.GetEnv("GITOPS_ARGOCD_INSTANCE_LABEL", ""),
		URL:                strings.TrimRight(pkgconfig.GetEnv("GITOPS_ARGOCD_URL", ""), "/"),
	}
}

// Blocks reports whether a write to a managed object must be refused.
func (c Config) Blocks() bool { return c.Enabled && c.Mode == ModeBlock }

// Result names the Application that manages an object.
type Result struct {
	Managed bool
	App     string
	Method  string // annotation | label
}

// Object is the part of an object the check reads. Group is the API group
// ("" for core), Kind the kind as the API server spells it.
type Object struct {
	Group, Kind, Namespace, Name string
	Annotations, Labels          map[string]string
}

// Detect reads the Argo CD marks on obj. The tracking annotation counts only
// when it names this very object, so an annotation copied along with a
// template (a Pod made from a Deployment's pod template, a backup) does not
// claim the copy. The instance label is consulted only when configured.
func (c Config) Detect(obj Object) Result {
	if !c.Enabled {
		return Result{}
	}
	if v := obj.Annotations[c.TrackingAnnotation]; v != "" {
		if app, ok := parseTrackingID(v, obj); ok {
			return Result{Managed: true, App: app, Method: "annotation"}
		}
	}
	if c.InstanceLabel != "" {
		if app := obj.Labels[c.InstanceLabel]; app != "" {
			return Result{Managed: true, App: app, Method: "label"}
		}
	}
	return Result{}
}

// parseTrackingID checks "app:group/Kind:namespace/name" against obj.
func parseTrackingID(v string, obj Object) (string, bool) {
	parts := strings.SplitN(v, ":", 3)
	if len(parts) != 3 || parts[0] == "" {
		return "", false
	}
	gk := strings.SplitN(parts[1], "/", 2)
	if len(gk) != 2 {
		return "", false
	}
	nn := strings.SplitN(parts[2], "/", 2)
	if len(nn) != 2 {
		return "", false
	}
	if gk[0] != obj.Group || gk[1] != obj.Kind || nn[0] != obj.Namespace || nn[1] != obj.Name {
		return "", false
	}
	return parts[0], true
}
