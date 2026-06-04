package k8s

// Topology node/edge types matching the Python implementation.
//
// Per-graph builders live in sibling files (topology_*.go):
//   - topology_namespace.go: GetNamespaceTopology
//   - topology_resource.go : GetServiceTopology / GetDeploymentTopology
//   - topology_storage.go  : GetStorageTopology
//
// This file keeps the shared constants and small selector helpers used
// across those builders.

const (
	NodeTypeService     = "service"
	NodeTypeDeployment  = "deployment"
	NodeTypeStatefulSet = "statefulset"
	NodeTypeDaemonSet   = "daemonset"
	NodeTypePod         = "pod"
	NodeTypePVC         = "pvc"
	NodeTypePV          = "pv"
	NodeTypeConfigMap   = "configmap"
	NodeTypeSecret      = "secret"
	NodeTypeIngress     = "ingress"

	EdgeTypeRoutesTo = "routes_to"
	EdgeTypeManages  = "manages"
	EdgeTypeUses     = "uses"
	EdgeTypeMounts   = "mounts"
	EdgeTypeBoundTo  = "bound_to"
)

// selectorMatches checks if all selector key/value pairs exist in labels.
func selectorMatches(selector map[string]string, labels map[string]string) bool {
	if len(selector) == 0 {
		return false
	}
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}

// extractStringMap extracts a map[string]string from map[string]interface{} field.
func extractStringMap(m map[string]interface{}, key string) map[string]string {
	val, ok := m[key]
	if !ok || val == nil {
		return nil
	}
	switch v := val.(type) {
	case map[string]string:
		return v
	case map[string]interface{}:
		return mapStrMap(v)
	}
	return nil
}
