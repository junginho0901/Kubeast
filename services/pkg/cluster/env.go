package cluster

import (
	"context"
	"fmt"
	"os"
)

// EnvRegistry is a single-cluster Registry backed by environment variables
// (IN_CLUSTER / KUBECONFIG_PATH). It exposes exactly one cluster, Default.
//
// IsSelfCluster is always false even when IN_CLUSTER=true: the cluster kubeast
// runs in is only registered as "managed" by explicit admin action, never
// automatically.
type EnvRegistry struct {
	info Info
}

// NewEnvRegistry builds the single-cluster registry from the environment.
func NewEnvRegistry() *EnvRegistry {
	info := Info{ID: Default, DisplayName: "Default Cluster"}
	switch {
	case os.Getenv("IN_CLUSTER") == "true":
		info.Mode = ModeInCluster
		info.InCluster = true
	case os.Getenv("KUBECONFIG_PATH") != "":
		info.Mode = ModeExternal
		info.KubeconfigPath = os.Getenv("KUBECONFIG_PATH")
	}
	// When neither is set the connection fields stay empty; the k8s service
	// falls back to ~/.kube/config.
	return &EnvRegistry{info: info}
}

// List returns the single configured cluster.
func (r *EnvRegistry) List(context.Context) ([]Info, error) {
	return []Info{r.info}, nil
}

// Get returns the Default cluster, or ErrNotFound for any other ID.
func (r *EnvRegistry) Get(_ context.Context, id ID) (*Info, error) {
	if id != Default {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	out := r.info
	return &out, nil
}

// Default always returns the Default cluster ID.
func (r *EnvRegistry) Default(context.Context) (ID, error) {
	return Default, nil
}
