package config

import (
	"os"
	"strings"
)

// SwitchOn is one rule for an on/off switch's value, the same as ai-service's app/services/switch.py
// (ai-service/tests/fixtures/switch_cases.json holds the two equal): true, 1, on or yes in any case, with spaces around
// it, is on; anything else, empty included, is off.
func SwitchOn(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "1", "on", "yes":
		return true
	}
	return false
}

// EnvSwitch is SwitchOn of the environment variable name.
func EnvSwitch(name string) bool { return SwitchOn(os.Getenv(name)) }
