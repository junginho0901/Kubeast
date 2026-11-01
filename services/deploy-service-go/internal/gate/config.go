package gate

import (
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/target"
)

// ConfigFor is the gate an environment asks for: its rule modes, allowed
// registries and schema locations, with the installer's own Rego modules.
func ConfigFor(env *target.Env, policies []File) Config {
	modes := make(map[string]Mode, len(env.Policy.Modes))
	for r, m := range env.Policy.Modes {
		modes[r] = Mode(m)
	}
	return Config{
		KubernetesVersion: env.Policy.KubernetesVersion,
		SchemaLocations:   env.Policy.SchemaLocations,
		Policies:          policies,
		AllowedRegistries: env.Policy.AllowedRegistries,
		Modes:             modes,
	}
}
