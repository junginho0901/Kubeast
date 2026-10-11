package handler

import "strings"

// permResource is the <name> in resource.<name>.<verb> for a Kubernetes kind:
// the lower-cased kind, a short name for six kinds, and "customresource" for
// any kind without a permission name of its own. The frontend mirrors it in
// frontend/src/utils/permissions.ts (permResource) — keep the two lists the same.
func permResource(kind string) string {
	k := strings.ToLower(kind)
	if alias, ok := permResourceAliases[k]; ok {
		return alias
	}
	if permResourceKinds[k] {
		return k
	}
	return "customresource"
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
	"gateway": true, "gatewayclass": true, "httproute": true, "grpcroute": true, "referencegrant": true, "backendtlspolicy": true,
	"deviceclass": true, "resourceclaim": true, "resourceclaimtemplate": true, "resourceslice": true,
}
