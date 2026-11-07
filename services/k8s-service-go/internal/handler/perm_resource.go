package handler

import "github.com/junginho0901/kubeast/services/pkg/auth"

// permResource is the <name> in resource.<name>.<verb> for a Kubernetes kind (auth.PermResource).
func permResource(kind string) string { return auth.PermResource(kind) }
