// Package source is where a workload's description comes from. A source
// gives the same files in the same layout whether it reads a git checkout
// or the database (design ⓑ §8-1, decision 31), so the renderer, the gate,
// sync, the screens and the AI tools do not depend on which one it is.
//
// The layout:
//
//	services/<name>/score.yaml          the workload, the developer's part
//	services/<name>/patches/*.yaml      changes to rendered objects
//	services/<name>/raw/*.yaml          objects the renderer does not make
//	services/<name>/...                 files a container's `source` names
//	environments/<env>/_defaults.yaml   the environment's defaults
//	environments/<env>/<name>.score.yaml  what the environment changes (optional)
//	policies/*.rego                     the installer's gate rules
package source

import (
	"context"
	"errors"
	"io/fs"
)

// ErrNotFound marks a workload or environment the source does not have.
var ErrNotFound = errors.New("not found")

// Source reads workloads. Implementations are safe for concurrent use.
type Source interface {
	// Services lists the workloads, sorted.
	Services(ctx context.Context) ([]string, error)
	// Environments lists the environments that have defaults, sorted.
	Environments(ctx context.Context) ([]string, error)
	// Load reads one workload as one environment sees it.
	Load(ctx context.Context, service, env string) (*Bundle, error)
}

// File is one file of a bundle, named by its path in the layout.
type File struct {
	Name string
	Data []byte
}

// Bundle is everything a plan needs for one workload in one environment.
type Bundle struct {
	Service string
	Env     string
	// Revision names what was read: a commit, or a version in the database.
	Revision string
	Score    []byte
	// Overrides is nil when the environment changes nothing.
	Overrides []byte
	Defaults  []byte
	Patches   []File
	Raw       []File
	Policies  []File
	// Files is the workload's folder, where file sources are read from.
	Files fs.FS
}
