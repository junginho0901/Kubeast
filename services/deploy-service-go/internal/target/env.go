// Package target holds an environment's defaults: where a workload goes and
// the values the renderer fills in that a Score file does not say. They come
// from environments/<env>/_defaults.yaml (or the database source) and are the
// knobs an installer turns instead of patching the renderer.
package target

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"sigs.k8s.io/yaml"
)

// Env is one environment's defaults.
type Env struct {
	// Name is the environment (alpha, beta, prod …).
	Name string `json:"name"`
	// Namespace is a pattern: {service} and {env} are replaced.
	Namespace string `json:"namespace,omitempty"`
	// Replicas is used when the workload sets neither replicas nor autoscale.
	Replicas int `json:"replicas,omitempty"`
	// Resources fill what a container leaves out.
	Resources Resources `json:"resources,omitempty"`
	// HostUsers false (the default) runs pods in a user namespace; true is
	// for clusters before Kubernetes 1.36 or nodes that cannot.
	HostUsers bool `json:"hostUsers,omitempty"`
	// Spread is the topology keys to spread over: zone, hostname. An empty
	// list turns spreading off; leaving it out spreads over both.
	Spread *[]string `json:"spread,omitempty"`
	// MaxSurge is the Deployment's rolling surge; maxUnavailable is 0.
	MaxSurge string `json:"maxSurge,omitempty"`
	// TmpSize is the size limit of the /tmp emptyDir every container gets.
	TmpSize string `json:"tmpSize,omitempty"`
	// ReadinessFromPort adds a TCP readiness check on the first service
	// port when a single-container workload has none (default true).
	ReadinessFromPort *bool `json:"readinessFromPort,omitempty"`
	// Gateway is the parent the HTTPRoutes attach to.
	Gateway *ParentRef `json:"gateway,omitempty"`
	// Domain is a host pattern for dns resources: {service}, {env}, {resource}.
	Domain string `json:"domain,omitempty"`
	// SecretStore is the External Secrets store secret resources read from.
	SecretStore *SecretStore `json:"secretStore,omitempty"`
	// ServiceAccountClass is the default class of service-account resources:
	// none or aws-irsa.
	ServiceAccountClass string `json:"serviceAccountClass,omitempty"`
	// Profiles place pods on nodes; a workload picks one by name.
	Profiles       map[string]Profile `json:"profiles,omitempty"`
	DefaultProfile string             `json:"defaultProfile,omitempty"`
	// Capabilities says which optional APIs the target cluster has.
	Capabilities Capabilities `json:"capabilities,omitempty"`
}

// Resources are container requests and limits.
type Resources struct {
	Requests Quantities `json:"requests,omitempty"`
	Limits   Quantities `json:"limits,omitempty"`
}

// Quantities are Kubernetes quantity strings.
type Quantities struct {
	CPU    string `json:"cpu,omitempty"`
	Memory string `json:"memory,omitempty"`
}

// ParentRef is a Gateway API parent reference.
type ParentRef struct {
	Name        string `json:"name"`
	Namespace   string `json:"namespace,omitempty"`
	SectionName string `json:"sectionName,omitempty"`
}

// SecretStore is an External Secrets store reference.
type SecretStore struct {
	Kind            string `json:"kind,omitempty"`
	Name            string `json:"name"`
	RefreshInterval string `json:"refreshInterval,omitempty"`
}

// Profile is node placement.
type Profile struct {
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`
	Tolerations  []Toleration      `json:"tolerations,omitempty"`
}

// Toleration is a pod toleration.
type Toleration struct {
	Key               string `json:"key,omitempty"`
	Operator          string `json:"operator,omitempty"`
	Value             string `json:"value,omitempty"`
	Effect            string `json:"effect,omitempty"`
	TolerationSeconds *int64 `json:"tolerationSeconds,omitempty"`
}

// Capabilities of the target cluster. Until the sync step reads them from the
// cluster, the environment states them; missing APIs are not rendered.
type Capabilities struct {
	GatewayAPI      bool `json:"gatewayAPI,omitempty"`
	ExternalSecrets bool `json:"externalSecrets,omitempty"`
	ServiceMonitor  bool `json:"serviceMonitor,omitempty"`
}

var (
	dnsLabel = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	surge    = regexp.MustCompile(`^[0-9]+%?$`)
)

// Parse reads an environment file, refusing unknown fields, and fills the
// defaults.
func Parse(data []byte) (*Env, error) {
	var e Env
	if err := yaml.UnmarshalStrict(data, &e); err != nil {
		return nil, fmt.Errorf("environment file: %w", err)
	}
	if err := e.fill(); err != nil {
		return nil, err
	}
	return &e, nil
}

func (e *Env) fill() error {
	var errs []error
	if !dnsLabel.MatchString(e.Name) || len(e.Name) > 63 {
		errs = append(errs, fmt.Errorf("environment name %q is not a DNS label", e.Name))
	}
	if e.Namespace == "" {
		e.Namespace = "{service}-{env}"
	}
	if e.Replicas == 0 {
		e.Replicas = 1
	}
	if e.Resources.Requests.CPU == "" {
		e.Resources.Requests.CPU = "100m"
	}
	if e.Resources.Requests.Memory == "" {
		e.Resources.Requests.Memory = "128Mi"
	}
	if e.Resources.Limits.Memory == "" {
		e.Resources.Limits.Memory = "256Mi"
	}
	if e.Spread == nil {
		both := []string{"zone", "hostname"}
		e.Spread = &both
	}
	for _, s := range *e.Spread {
		if s != "zone" && s != "hostname" {
			errs = append(errs, fmt.Errorf("environment spread %q: zone or hostname", s))
		}
	}
	if e.MaxSurge == "" {
		e.MaxSurge = "25%"
	}
	if !surge.MatchString(e.MaxSurge) {
		errs = append(errs, fmt.Errorf("environment maxSurge %q: a number or a percentage", e.MaxSurge))
	}
	if e.TmpSize == "" {
		e.TmpSize = "64Mi"
	}
	if e.ReadinessFromPort == nil {
		on := true
		e.ReadinessFromPort = &on
	}
	if e.SecretStore != nil {
		if e.SecretStore.Kind == "" {
			e.SecretStore.Kind = "ClusterSecretStore"
		}
		if e.SecretStore.RefreshInterval == "" {
			e.SecretStore.RefreshInterval = "1h"
		}
		if e.SecretStore.Name == "" {
			errs = append(errs, errors.New("environment secretStore needs a name"))
		}
	}
	if e.Gateway != nil && e.Gateway.Name == "" {
		errs = append(errs, errors.New("environment gateway needs a name"))
	}
	switch e.ServiceAccountClass {
	case "":
		e.ServiceAccountClass = "none"
	case "none", "aws-irsa":
	default:
		errs = append(errs, fmt.Errorf("environment serviceAccountClass %q: none or aws-irsa", e.ServiceAccountClass))
	}
	if e.DefaultProfile != "" {
		if _, ok := e.Profiles[e.DefaultProfile]; !ok {
			errs = append(errs, fmt.Errorf("environment defaultProfile %q is not in profiles (%s)", e.DefaultProfile, strings.Join(e.ProfileNames(), ", ")))
		}
	}
	return errors.Join(errs...)
}

// NamespaceFor is the namespace of a workload in this environment.
func (e *Env) NamespaceFor(service string) (string, error) {
	ns := e.expand(e.Namespace, service, "")
	if !dnsLabel.MatchString(ns) || len(ns) > 63 {
		return "", fmt.Errorf("namespace %q (from %q) is not a DNS label", ns, e.Namespace)
	}
	return ns, nil
}

// HostFor is the host a dns resource gets, "" when the environment has no
// domain pattern.
func (e *Env) HostFor(service, resource string) string {
	if e.Domain == "" {
		return ""
	}
	return e.expand(e.Domain, service, resource)
}

// ProfileNames lists the profiles in order.
func (e *Env) ProfileNames() []string {
	names := make([]string, 0, len(e.Profiles))
	for n := range e.Profiles {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func (e *Env) expand(pattern, service, resource string) string {
	return strings.NewReplacer("{service}", service, "{env}", e.Name, "{resource}", resource).Replace(pattern)
}
