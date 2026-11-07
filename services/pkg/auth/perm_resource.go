package auth

import (
	"sort"
	"strings"
)

// PermResource is the <name> in resource.<name>.<verb> for a Kubernetes kind:
// the lower-cased kind, a short name for six kinds, and "customresource" for
// any kind without a permission name of its own. The frontend mirrors it in
// frontend/src/utils/permissions.ts (permResource) and ai-service in
// app/services/ai/screen_permissions.py — keep the lists the same.
func PermResource(kind string) string {
	k := strings.ToLower(kind)
	if alias, ok := permResourceAliases[k]; ok {
		return alias
	}
	if permResourceKinds[k] {
		return k
	}
	return "customresource"
}

// PermResourceNames lists every permission name PermResource can answer, sorted.
func PermResourceNames() []string {
	names := []string{"customresource"}
	for _, alias := range permResourceAliases {
		names = append(names, alias)
	}
	for kind := range permResourceKinds {
		names = append(names, kind)
	}
	sort.Strings(names)
	return names
}

var permResourceAliases = map[string]string{
	"horizontalpodautoscaler":  "hpa",
	"verticalpodautoscaler":    "vpa",
	"poddisruptionbudget":      "pdb",
	"persistentvolume":         "pv",
	"persistentvolumeclaim":    "pvc",
	"customresourcedefinition": "crd",
}

var permResourceKinds = map[string]bool{
	"pod": true, "deployment": true, "statefulset": true, "daemonset": true, "replicaset": true, "job": true, "cronjob": true,
	"service": true, "endpoints": true, "endpointslice": true, "ingress": true, "ingressclass": true, "networkpolicy": true,
	"configmap": true, "secret": true, "serviceaccount": true,
	"role": true, "rolebinding": true, "clusterrole": true, "clusterrolebinding": true,
	"namespace": true, "node": true, "storageclass": true, "volumeattachment": true,
	"resourcequota": true, "limitrange": true, "priorityclass": true, "runtimeclass": true, "lease": true,
	"mutatingwebhookconfiguration": true, "validatingwebhookconfiguration": true,
	"validatingadmissionpolicy": true, "validatingadmissionpolicybinding": true, "mutatingadmissionpolicy": true, "mutatingadmissionpolicybinding": true,
	"gateway": true, "gatewayclass": true, "httproute": true, "grpcroute": true, "referencegrant": true, "backendtlspolicy": true,
	"deviceclass": true, "resourceclaim": true, "resourceclaimtemplate": true, "resourceslice": true,
	"cost": true, "policyreport": true, "networkflow": true,
}
