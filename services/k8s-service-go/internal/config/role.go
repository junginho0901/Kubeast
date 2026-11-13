package config

import (
	"fmt"
	"strings"
)

// Role is what one k8s-service process serves (SERVER_ROLE). The image is the same in every role, as Loki's and
// Mimir's -target picks the components one binary runs: "all" is the whole service, "api" leaves out the terminals and
// followed logs, "stream" serves only those.
type Role string

const (
	RoleAll    Role = "all"
	RoleAPI    Role = "api"
	RoleStream Role = "stream"
)

// ParseRole reads SERVER_ROLE; empty is RoleAll.
func ParseRole(s string) (Role, error) {
	switch r := Role(strings.ToLower(strings.TrimSpace(s))); r {
	case "":
		return RoleAll, nil
	case RoleAll, RoleAPI, RoleStream:
		return r, nil
	}
	return "", fmt.Errorf("SERVER_ROLE %q is not one of all, api, stream", s)
}

// ServesAPI is the lists, details, writes, watches and the /internal routes, with the work behind them: the cluster
// health checks and the overview informers.
func (r Role) ServesAPI() bool { return r == RoleAll || r == RoleAPI }

// ServesStreams is the terminals (pod exec, node shell) and the followed logs (pod logs, log files), with the session
// recordings they write.
func (r Role) ServesStreams() bool { return r == RoleAll || r == RoleStream }
