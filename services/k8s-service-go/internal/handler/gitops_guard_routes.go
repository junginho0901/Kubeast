package handler

import (
	"net/http"
)

// gitopsRoutePermission asks the permission the route's own handler asks, so the
// guard says nothing to someone who could not make the write. Whichever route a
// write has, TestEveryWriteRouteAsksItsPermissionBeforeTheGuardLooks holds this
// table to what its handler answers.
func (h *Handler) gitopsRoutePermission(r *http.Request) error {
	key := r.Method + " " + routePattern(r)
	if key == "POST /api/v1/resources/yaml/apply" {
		var body applyYAMLBody
		if !peekJSON(r, &body) {
			return nil // the handler's 400
		}
		kind, err := h.svc.ResourceKind(r.Context(), body.ResourceType)
		if err != nil {
			return err
		}
		return h.requirePermissionForCluster(r, "resource."+permResource(kind)+".edit")
	}
	if perm, ok := gitopsWritePermissions[key]; ok {
		return h.requirePermissionForCluster(r, perm)
	}
	return nil
}

var gitopsWritePermissions = map[string]string{
	"DELETE /api/v1/clusterrolebindings/{name}":                                     "resource.clusterrolebinding.delete",
	"DELETE /api/v1/clusterroles/{name}":                                            "resource.clusterrole.delete",
	"DELETE /api/v1/crds/{name}":                                                    "resource.crd.delete",
	"DELETE /api/v1/custom-resources/{group}/{version}/{plural}/{namespace}/{name}": "resource.customresource.delete",
	"DELETE /api/v1/deviceclasses/{name}":                                           "resource.deviceclass.delete",
	"DELETE /api/v1/gatewayclasses/{name}":                                          "resource.gatewayclass.delete",
	"DELETE /api/v1/ingressclasses/{name}":                                          "resource.ingressclass.delete",
	"DELETE /api/v1/mutatingwebhookconfigurations/{name}":                           "resource.mutatingwebhookconfiguration.delete",
	"DELETE /api/v1/namespaces/{namespace}":                                         "resource.namespace.delete",
	"DELETE /api/v1/namespaces/{namespace}/backendtlspolicies/{name}":               "resource.backendtlspolicy.delete",
	"DELETE /api/v1/namespaces/{namespace}/configmaps/{name}":                       "resource.configmap.delete",
	"DELETE /api/v1/namespaces/{namespace}/cronjobs/{name}":                         "resource.cronjob.delete",
	"DELETE /api/v1/namespaces/{namespace}/daemonsets/{name}":                       "resource.daemonset.delete",
	"DELETE /api/v1/namespaces/{namespace}/deployments/{deployment_name}":           "resource.deployment.delete",
	"DELETE /api/v1/namespaces/{namespace}/endpoints/{name}":                        "resource.endpoints.delete",
	"DELETE /api/v1/namespaces/{namespace}/endpointslices/{name}":                   "resource.endpointslice.delete",
	"DELETE /api/v1/namespaces/{namespace}/gateways/{name}":                         "resource.gateway.delete",
	"DELETE /api/v1/namespaces/{namespace}/grpcroutes/{name}":                       "resource.grpcroute.delete",
	"DELETE /api/v1/namespaces/{namespace}/hpas/{name}":                             "resource.hpa.delete",
	"DELETE /api/v1/namespaces/{namespace}/httproutes/{name}":                       "resource.httproute.delete",
	"DELETE /api/v1/namespaces/{namespace}/ingresses/{name}":                        "resource.ingress.delete",
	"DELETE /api/v1/namespaces/{namespace}/jobs/{name}":                             "resource.job.delete",
	"DELETE /api/v1/namespaces/{namespace}/leases/{name}":                           "resource.lease.delete",
	"DELETE /api/v1/namespaces/{namespace}/limitranges/{name}":                      "resource.limitrange.delete",
	"DELETE /api/v1/namespaces/{namespace}/networkpolicies/{name}":                  "resource.networkpolicy.delete",
	"DELETE /api/v1/namespaces/{namespace}/pdbs/{name}":                             "resource.pdb.delete",
	"DELETE /api/v1/namespaces/{namespace}/pods/{pod_name}":                         "resource.pod.delete",
	"DELETE /api/v1/namespaces/{namespace}/pvcs/{name}":                             "resource.pvc.delete",
	"DELETE /api/v1/namespaces/{namespace}/referencegrants/{name}":                  "resource.referencegrant.delete",
	"DELETE /api/v1/namespaces/{namespace}/replicasets/{name}":                      "resource.replicaset.delete",
	"DELETE /api/v1/namespaces/{namespace}/resourceclaims/{name}":                   "resource.resourceclaim.delete",
	"DELETE /api/v1/namespaces/{namespace}/resourceclaimtemplates/{name}":           "resource.resourceclaimtemplate.delete",
	"DELETE /api/v1/namespaces/{namespace}/resourcequotas/{name}":                   "resource.resourcequota.delete",
	"DELETE /api/v1/namespaces/{namespace}/rolebindings/{name}":                     "resource.rolebinding.delete",
	"DELETE /api/v1/namespaces/{namespace}/roles/{name}":                            "resource.role.delete",
	"DELETE /api/v1/namespaces/{namespace}/secrets/{name}":                          "resource.secret.delete",
	"DELETE /api/v1/namespaces/{namespace}/serviceaccounts/{name}":                  "resource.serviceaccount.delete",
	"DELETE /api/v1/namespaces/{namespace}/services/{name}":                         "resource.service.delete",
	"DELETE /api/v1/namespaces/{namespace}/statefulsets/{name}":                     "resource.statefulset.delete",
	"DELETE /api/v1/namespaces/{namespace}/vpas/{name}":                             "resource.vpa.delete",
	"DELETE /api/v1/nodes/{name}":                                                   "resource.node.delete",
	"DELETE /api/v1/priorityclasses/{name}":                                         "resource.priorityclass.delete",
	"DELETE /api/v1/pvs/{name}":                                                     "resource.pv.delete",
	"DELETE /api/v1/resourceslices/{name}":                                          "resource.resourceslice.delete",
	"DELETE /api/v1/runtimeclasses/{name}":                                          "resource.runtimeclass.delete",
	"DELETE /api/v1/storageclasses/{name}":                                          "resource.storageclass.delete",
	"DELETE /api/v1/validatingwebhookconfigurations/{name}":                         "resource.validatingwebhookconfiguration.delete",
	"DELETE /api/v1/volumeattachments/{name}":                                       "resource.volumeattachment.delete",
	"PATCH /api/v1/namespaces/{namespace}/cronjobs/{name}/suspend":                  "resource.cronjob.suspend",
	"POST /api/v1/namespaces/{namespace}/cronjobs/{name}/trigger":                   "resource.cronjob.trigger",
	"POST /api/v1/namespaces/{namespace}/daemonsets/{name}/rollback":                "resource.workload.rollback",
	"POST /api/v1/namespaces/{namespace}/deployments/{name}/rollback":               "resource.workload.rollback",
	"POST /api/v1/namespaces/{namespace}/optimization/resize":                       "resource.pod.edit",
	"POST /api/v1/namespaces/{namespace}/statefulsets/{name}/rollback":              "resource.workload.rollback",
	"POST /api/v1/namespaces/{namespace}/yaml/apply":                                "resource.namespace.edit",
	"POST /api/v1/nodes/{name}/cordon":                                              "resource.node.cordon",
	"POST /api/v1/nodes/{name}/drain":                                               "resource.node.drain",
	"POST /api/v1/nodes/{name}/uncordon":                                            "resource.node.cordon",
	"POST /api/v1/nodes/{name}/yaml/apply":                                          "resource.node.edit",
}
