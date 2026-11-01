package webhook

import (
	"encoding/json"
	"fmt"
	"net/netip"
)

// ParseMetaHooks reads the address ranges GitHub delivers webhooks from,
// the "hooks" list of GET https://api.github.com/meta. GitHub changes them
// from time to time, so the controller reads them again periodically and
// keeps the last good list when a read fails.
func ParseMetaHooks(body []byte) ([]netip.Prefix, error) {
	var meta struct {
		Hooks []string `json:"hooks"`
	}
	if err := json.Unmarshal(body, &meta); err != nil {
		return nil, fmt.Errorf("webhook: meta answer: %w", err)
	}
	if len(meta.Hooks) == 0 {
		return nil, ErrNoHooks
	}
	out := make([]netip.Prefix, 0, len(meta.Hooks))
	for _, s := range meta.Hooks {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return nil, fmt.Errorf("webhook: meta hook range %q: %w", s, err)
		}
		out = append(out, p.Masked())
	}
	return out, nil
}
