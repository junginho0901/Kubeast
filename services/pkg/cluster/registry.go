// Package cluster defines the cluster identity and registry abstraction used
// across all backend services. The registry is the single source of truth for
// "what clusters does this deployment know about?".
package cluster

import (
	"context"
	"errors"
)

// ID is a cluster's unique identifier (a URL-safe slug). Single-cluster
// deployments use Default.
type ID string

// Default is the cluster ID used when a request does not specify one. Handlers
// and the frontend fall back to it so existing single-cluster behaviour is
// unchanged.
const Default ID = "default"

// Mode describes how a cluster is connected.
type Mode string

const (
	ModeInCluster Mode = "in_cluster" // use the in-cluster ServiceAccount
	ModeExternal  Mode = "external"   // use a kubeconfig
)

// Info describes one managed cluster. Exactly one connection field is
// meaningful at runtime, selected by Mode.
type Info struct {
	ID          ID
	DisplayName string
	Mode        Mode

	// Connection — exactly one is used, per Mode.
	InCluster      bool   // rest.InClusterConfig()
	KubeconfigPath string // path to a kubeconfig file (docker / single)
	KubeconfigBlob string // inline kubeconfig contents (loaded from a Secret)

	// IsSelfCluster is true when this Info points at the cluster kubeast itself
	// runs in. It is only set when an admin explicitly registers the self
	// cluster — single-cluster deployments leave it false.
	IsSelfCluster bool
}

// Registry is the source of truth for the set of managed clusters.
type Registry interface {
	List(ctx context.Context) ([]Info, error)
	Get(ctx context.Context, id ID) (*Info, error)
	Default(ctx context.Context) (ID, error)
}

// ErrNotFound is returned by Registry.Get for an unknown cluster ID.
var ErrNotFound = errors.New("cluster: not found")

// ErrAlreadyExists is returned when registering a cluster whose ID (the
// slugified display name) is already taken.
var ErrAlreadyExists = errors.New("cluster: already exists")
