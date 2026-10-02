// 리소스 삭제 mutation hook. ResourceDetailDrawer.tsx 에서 추출 (Phase 3.3.b).
//
// kind 별로 다른 api.deleteXxx 를 호출하는 거대한 mutationFn (~500줄) 을
// 캡슐화. 부모는 close 콜백만 전달, 모달 state (deleteDialogOpen / deleteError)
// 는 hook 자체 보유. close() 가 setTarget(null) 호출 → drawer unmount → hook
// 자체 unmount 라 추가 reset 불필요.

import { useState } from 'react'
import { flushSync } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '@/services/api'

interface Target {
  kind: string
  namespace: string | null
  name: string
  rawJson?: any
}

interface Args {
  target: Target | null
  close: () => void
}

export function useResourceDelete({ target, close }: Args) {
  const queryClient = useQueryClient()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const kind = target?.kind ?? ''
  const ns = target?.namespace ?? null
  const name = target?.name ?? ''

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (kind === 'Pod' && ns) {
        await api.deletePod(ns, name)
        return
      }
      if (kind === 'Namespace') {
        await api.deleteNamespace(name)
        return
      }
      if (kind === 'Node') {
        await api.deleteNode(name)
        return
      }
      if (kind === 'Deployment' && ns) {
        await api.deleteDeployment(ns, name)
        return
      }
      if (kind === 'StatefulSet' && ns) {
        await api.deleteStatefulSet(ns, name)
        return
      }
      if (kind === 'DaemonSet' && ns) {
        await api.deleteDaemonSet(ns, name)
        return
      }
      if (kind === 'Job' && ns) {
        await api.deleteJob(ns, name)
        return
      }
      if (kind === 'ReplicaSet' && ns) {
        await api.deleteReplicaSet(ns, name)
        return
      }
      if (kind === 'CronJob' && ns) {
        await api.deleteCronJob(ns, name)
        return
      }
      if (kind === 'PersistentVolumeClaim' && ns) {
        await api.deletePVC(ns, name)
        return
      }
      if (kind === 'PersistentVolume') {
        await api.deletePV(name)
        return
      }
      if (kind === 'StorageClass') {
        await api.deleteStorageClass(name)
        return
      }
      if (kind === 'VolumeAttachment') {
        await api.deleteVolumeAttachment(name)
        return
      }
      if (kind === 'Service' && ns) {
        await api.deleteService(ns, name)
        return
      }
      if (kind === 'Endpoints' && ns) {
        await api.deleteEndpoint(ns, name)
        return
      }
      if (kind === 'EndpointSlice' && ns) {
        await api.deleteEndpointSlice(ns, name)
        return
      }
      if (kind === 'Ingress' && ns) {
        await api.deleteIngress(ns, name)
        return
      }
      if (kind === 'IngressClass') {
        await api.deleteIngressClass(name)
        return
      }
      if (kind === 'NetworkPolicy' && ns) {
        await api.deleteNetworkPolicy(ns, name)
        return
      }
      if (kind === 'Gateway' && ns) {
        await api.deleteGateway(ns, name)
        return
      }
      if (kind === 'GatewayClass') {
        await api.deleteGatewayClass(name)
        return
      }
      if (kind === 'HTTPRoute' && ns) {
        await api.deleteHTTPRoute(ns, name)
        return
      }
      if (kind === 'GRPCRoute' && ns) {
        await api.deleteGRPCRoute(ns, name)
        return
      }
      if (kind === 'ReferenceGrant' && ns) {
        await api.deleteReferenceGrant(ns, name)
        return
      }
      if (kind === 'BackendTLSPolicy' && ns) {
        await api.deleteBackendTLSPolicy(ns, name)
        return
      }
      if (kind === 'DeviceClass') {
        await api.deleteDeviceClass(name)
        return
      }
      if (kind === 'ResourceClaim' && ns) {
        await api.deleteResourceClaim(ns, name)
        return
      }
      if (kind === 'ResourceClaimTemplate' && ns) {
        await api.deleteResourceClaimTemplate(ns, name)
        return
      }
      if (kind === 'ResourceSlice') {
        await api.deleteResourceSlice(name)
        return
      }
      if (kind === 'ServiceAccount' && ns) {
        await api.deleteServiceAccount(ns, name)
        return
      }
      if (kind === 'Role' && ns) {
        await api.deleteRole(ns, name)
        return
      }
      if (kind === 'RoleBinding' && ns) {
        await api.deleteRoleBinding(ns, name)
        return
      }
      if (kind === 'ClusterRole') {
        await api.deleteClusterRole(name)
        return
      }
      if (kind === 'ClusterRoleBinding') {
        await api.deleteClusterRoleBinding(name)
        return
      }
      if (kind === 'ConfigMap' && ns) {
        await api.deleteConfigMap(ns, name)
        return
      }
      if (kind === 'Secret' && ns) {
        await api.deleteSecret(ns, name)
        return
      }
      if (kind === 'HorizontalPodAutoscaler' && ns) {
        await api.deleteHPA(ns, name)
        return
      }
      if (kind === 'VerticalPodAutoscaler' && ns) {
        await api.deleteVPA(ns, name)
        return
      }
      if (kind === 'PodDisruptionBudget' && ns) {
        await api.deletePDB(ns, name)
        return
      }
      if (kind === 'PriorityClass') {
        await api.deletePriorityClass(name)
        return
      }
      if (kind === 'RuntimeClass') {
        await api.deleteRuntimeClass(name)
        return
      }
      if (kind === 'Lease' && ns) {
        await api.deleteLease(ns, name)
        return
      }
      if (kind === 'ResourceQuota' && ns) {
        await api.deleteResourceQuota(ns, name)
        return
      }
      if (kind === 'LimitRange' && ns) {
        await api.deleteLimitRange(ns, name)
        return
      }
      if (kind === 'MutatingWebhookConfiguration') {
        await api.deleteMutatingWebhookConfiguration(name)
        return
      }
      if (kind === 'ValidatingWebhookConfiguration') {
        await api.deleteValidatingWebhookConfiguration(name)
        return
      }
      if (kind === 'CustomResourceDefinition') {
        await api.deleteCRD(name)
        return
      }
      if (kind === 'CustomResourceInstance') {
        const rj = target?.rawJson as Record<string, unknown> | undefined
        const g = (rj?.group as string) || ''
        const v = (rj?.version as string) || ''
        const crdN = (rj?.crd_name as string) || ''
        const pl = crdN ? crdN.split('.')[0] : ''
        if (g && v && pl) {
          await api.deleteCustomResourceInstance(g, v, pl, ns || '-', name)
          return
        }
      }
      throw new Error('Delete is not supported for this resource.')
    },
    onSuccess: async () => {
      // Unmount the drawer before invalidating: the describe queries below
      // belong to the object that no longer exists, and an invalidated query
      // only refetches while something still renders it. close() alone only
      // schedules the unmount, so it is flushed synchronously here — otherwise
      // the drawer's describe refetched first and logged a 404 on every delete.
      setDeleteDialogOpen(false)
      setDeleteError(null)
      flushSync(() => close())
      if (kind === 'Pod' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workloads', 'pods'] }),
          queryClient.invalidateQueries({ queryKey: ['workloads', 'pods', ns] }),
          queryClient.invalidateQueries({ queryKey: ['pod-describe', ns, name] }),
          queryClient.invalidateQueries({ queryKey: ['namespace-pods', ns] }),
        ])
      } else if (kind === 'Node') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes'] }),
          queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'describe', name] }),
          queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'pods', name] }),
          queryClient.invalidateQueries({ queryKey: ['cluster', 'node-metrics'] }),
        ])
      } else if (kind === 'Namespace') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['namespaces'] }),
          queryClient.invalidateQueries({ queryKey: ['namespace-describe', name] }),
          queryClient.invalidateQueries({ queryKey: ['namespace-pods', name] }),
          queryClient.invalidateQueries({ queryKey: ['namespace-rq', name] }),
          queryClient.invalidateQueries({ queryKey: ['namespace-lr', name] }),
        ])
      } else if (kind === 'Deployment' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workloads', 'deployments'] }),
          queryClient.invalidateQueries({ queryKey: ['workloads', 'deployments', ns] }),
        ])
      } else if (kind === 'StatefulSet' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workloads', 'statefulsets'] }),
          queryClient.invalidateQueries({ queryKey: ['workloads', 'statefulsets', ns] }),
          queryClient.invalidateQueries({ queryKey: ['statefulset-describe', ns, name] }),
        ])
      } else if (kind === 'DaemonSet' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workloads', 'daemonsets'] }),
          queryClient.invalidateQueries({ queryKey: ['workloads', 'daemonsets', ns] }),
          queryClient.invalidateQueries({ queryKey: ['daemonset-describe', ns, name] }),
          queryClient.invalidateQueries({ queryKey: ['workload-describe', 'DaemonSet', ns, name] }),
        ])
      } else if (kind === 'Job' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workloads', 'jobs'] }),
          queryClient.invalidateQueries({ queryKey: ['workloads', 'jobs', ns] }),
          queryClient.invalidateQueries({ queryKey: ['workload-describe', 'Job', ns, name] }),
        ])
      } else if (kind === 'ReplicaSet' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workloads', 'replicasets'] }),
          queryClient.invalidateQueries({ queryKey: ['workloads', 'replicasets', ns] }),
          queryClient.invalidateQueries({ queryKey: ['replicasets', ns] }),
          queryClient.invalidateQueries({ queryKey: ['workload-describe', 'ReplicaSet', ns, name] }),
        ])
      } else if (kind === 'CronJob' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workloads', 'cronjobs'] }),
          queryClient.invalidateQueries({ queryKey: ['workloads', 'cronjobs', ns] }),
          queryClient.invalidateQueries({ queryKey: ['workload-describe', 'CronJob', ns, name] }),
        ])
      } else if (kind === 'PersistentVolumeClaim' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['storage', 'pvcs'] }),
          queryClient.invalidateQueries({ queryKey: ['storage', 'pvcs', 'all'] }),
          queryClient.invalidateQueries({ queryKey: ['storage', 'pvcs', ns] }),
          queryClient.invalidateQueries({ queryKey: ['pvc-describe', ns, name] }),
        ])
      } else if (kind === 'PersistentVolume') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['storage', 'pvs'] }),
          queryClient.invalidateQueries({ queryKey: ['pv-describe', name] }),
        ])
      } else if (kind === 'StorageClass') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['storage', 'storageclasses'] }),
          queryClient.invalidateQueries({ queryKey: ['storageclass-describe', name] }),
        ])
      } else if (kind === 'VolumeAttachment') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['storage', 'volumeattachments'] }),
          queryClient.invalidateQueries({ queryKey: ['volumeattachment-describe', name] }),
        ])
      } else if (kind === 'Service' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['network', 'services'] }),
          queryClient.invalidateQueries({ queryKey: ['network', 'services', ns] }),
          queryClient.invalidateQueries({ queryKey: ['service-describe', ns, name] }),
        ])
      } else if (kind === 'Endpoints' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['network', 'endpoints'] }),
          queryClient.invalidateQueries({ queryKey: ['network', 'endpoints', ns] }),
          queryClient.invalidateQueries({ queryKey: ['endpoint-describe', ns, name] }),
        ])
      } else if (kind === 'EndpointSlice' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['network', 'endpointslices'] }),
          queryClient.invalidateQueries({ queryKey: ['network', 'endpointslices', ns] }),
          queryClient.invalidateQueries({ queryKey: ['endpointslice-describe', ns, name] }),
        ])
      } else if (kind === 'Ingress' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['network', 'ingresses'] }),
          queryClient.invalidateQueries({ queryKey: ['network', 'ingresses', ns] }),
          queryClient.invalidateQueries({ queryKey: ['ingress-detail', ns, name] }),
        ])
      } else if (kind === 'IngressClass') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['network', 'ingressclasses'] }),
          queryClient.invalidateQueries({ queryKey: ['ingressclass-describe', name] }),
        ])
      } else if (kind === 'NetworkPolicy' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['network', 'networkpolicies'] }),
          queryClient.invalidateQueries({ queryKey: ['network', 'networkpolicies', ns] }),
          queryClient.invalidateQueries({ queryKey: ['networkpolicy-describe', ns, name] }),
        ])
      } else if (kind === 'Gateway' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gateway', 'gateways'] }),
          queryClient.invalidateQueries({ queryKey: ['gateway', 'gateways', ns] }),
          queryClient.invalidateQueries({ queryKey: ['gateway-describe', ns, name] }),
        ])
      } else if (kind === 'GatewayClass') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gateway', 'gatewayclasses'] }),
          queryClient.invalidateQueries({ queryKey: ['gatewayclass-describe', name] }),
        ])
      } else if (kind === 'HTTPRoute' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gateway', 'httproutes'] }),
          queryClient.invalidateQueries({ queryKey: ['gateway', 'httproutes', ns] }),
          queryClient.invalidateQueries({ queryKey: ['httproute-describe', ns, name] }),
        ])
      } else if (kind === 'GRPCRoute' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gateway', 'grpcroutes'] }),
          queryClient.invalidateQueries({ queryKey: ['gateway', 'grpcroutes', ns] }),
          queryClient.invalidateQueries({ queryKey: ['grpcroute-describe', ns, name] }),
        ])
      } else if (kind === 'ReferenceGrant' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gateway', 'referencegrants'] }),
          queryClient.invalidateQueries({ queryKey: ['gateway', 'referencegrants', ns] }),
          queryClient.invalidateQueries({ queryKey: ['referencegrant-describe', ns, name] }),
        ])
      } else if (kind === 'BackendTLSPolicy' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gateway', 'backendtlspolicies'] }),
          queryClient.invalidateQueries({ queryKey: ['gateway', 'backendtlspolicies', ns] }),
          queryClient.invalidateQueries({ queryKey: ['backendtlspolicy-describe', ns, name] }),
        ])
      } else if (kind === 'DeviceClass') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gpu', 'deviceclasses'] }),
          queryClient.invalidateQueries({ queryKey: ['deviceclass-describe', name] }),
        ])
      } else if (kind === 'ResourceClaim' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gpu', 'resourceclaims'] }),
          queryClient.invalidateQueries({ queryKey: ['resourceclaim-describe', ns, name] }),
        ])
      } else if (kind === 'ResourceClaimTemplate' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gpu', 'resourceclaimtemplates'] }),
          queryClient.invalidateQueries({ queryKey: ['resourceclaimtemplate-describe', ns, name] }),
        ])
      } else if (kind === 'ResourceSlice') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gpu', 'resourceslices'] }),
          queryClient.invalidateQueries({ queryKey: ['resourceslice-describe', name] }),
        ])
      } else if (kind === 'ServiceAccount' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['security', 'serviceaccounts'] }),
          queryClient.invalidateQueries({ queryKey: ['security', 'serviceaccounts', ns] }),
          queryClient.invalidateQueries({ queryKey: ['serviceaccount-describe', ns, name] }),
        ])
      } else if (kind === 'Role' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['security', 'roles'] }),
          queryClient.invalidateQueries({ queryKey: ['security', 'roles', ns] }),
          queryClient.invalidateQueries({ queryKey: ['role-describe', ns, name] }),
        ])
      } else if (kind === 'RoleBinding' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['security', 'rolebindings'] }),
          queryClient.invalidateQueries({ queryKey: ['security', 'rolebindings', ns] }),
          queryClient.invalidateQueries({ queryKey: ['rolebinding-describe', ns, name] }),
        ])
      } else if (kind === 'ClusterRole') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['security', 'clusterroles'] }),
          queryClient.invalidateQueries({ queryKey: ['clusterrole-describe', name] }),
        ])
      } else if (kind === 'ClusterRoleBinding') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['security', 'clusterrolebindings'] }),
          queryClient.invalidateQueries({ queryKey: ['clusterrolebinding-describe', name] }),
        ])
      } else if (kind === 'ConfigMap' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['configuration', 'configmaps'] }),
          queryClient.invalidateQueries({ queryKey: ['configuration', 'configmaps', ns] }),
          queryClient.invalidateQueries({ queryKey: ['configmap-describe', ns, name] }),
        ])
      } else if (kind === 'Secret' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['configuration', 'secrets'] }),
          queryClient.invalidateQueries({ queryKey: ['configuration', 'secrets', ns] }),
          queryClient.invalidateQueries({ queryKey: ['secret-describe', ns, name] }),
        ])
      } else if (kind === 'HorizontalPodAutoscaler' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workloads', 'hpas'] }),
          queryClient.invalidateQueries({ queryKey: ['workloads', 'hpas', ns] }),
          queryClient.invalidateQueries({ queryKey: ['hpa-describe', ns, name] }),
        ])
      } else if (kind === 'VerticalPodAutoscaler' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workloads', 'vpas'] }),
          queryClient.invalidateQueries({ queryKey: ['workloads', 'vpas', ns] }),
          queryClient.invalidateQueries({ queryKey: ['vpa-describe', ns, name] }),
        ])
      } else if (kind === 'PodDisruptionBudget' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workloads', 'pdbs'] }),
          queryClient.invalidateQueries({ queryKey: ['workloads', 'pdbs', ns] }),
          queryClient.invalidateQueries({ queryKey: ['pdb-describe', ns, name] }),
        ])
      } else if (kind === 'PriorityClass') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cluster', 'priorityclasses'] }),
          queryClient.invalidateQueries({ queryKey: ['priorityclass-describe', name] }),
        ])
      } else if (kind === 'RuntimeClass') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cluster', 'runtimeclasses'] }),
          queryClient.invalidateQueries({ queryKey: ['runtimeclass-describe', name] }),
        ])
      } else if (kind === 'Lease' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cluster', 'leases'] }),
          queryClient.invalidateQueries({ queryKey: ['cluster', 'leases', ns] }),
          queryClient.invalidateQueries({ queryKey: ['lease-describe', ns, name] }),
        ])
      } else if (kind === 'ResourceQuota' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cluster', 'resourcequotas'] }),
          queryClient.invalidateQueries({ queryKey: ['cluster', 'resourcequotas', ns] }),
          queryClient.invalidateQueries({ queryKey: ['resourcequota-describe', ns, name] }),
          queryClient.invalidateQueries({ queryKey: ['namespace-rq', ns] }),
        ])
      } else if (kind === 'LimitRange' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cluster', 'limitranges'] }),
          queryClient.invalidateQueries({ queryKey: ['cluster', 'limitranges', ns] }),
          queryClient.invalidateQueries({ queryKey: ['limitrange-describe', ns, name] }),
          queryClient.invalidateQueries({ queryKey: ['namespace-lr', ns] }),
        ])
      } else if (kind === 'MutatingWebhookConfiguration') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cluster', 'mutatingwebhookconfigurations'] }),
          queryClient.invalidateQueries({ queryKey: ['mutatingwebhookconfiguration-describe', name] }),
        ])
      } else if (kind === 'ValidatingWebhookConfiguration') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cluster', 'validatingwebhookconfigurations'] }),
          queryClient.invalidateQueries({ queryKey: ['validatingwebhookconfiguration-describe', name] }),
        ])
      } else if (kind === 'CustomResourceDefinition') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['custom-resources', 'crds'] }),
          queryClient.invalidateQueries({ queryKey: ['crd-describe', name] }),
        ])
      } else if (kind === 'CustomResourceInstance') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['custom-resources', 'instances'] }),
          queryClient.invalidateQueries({ queryKey: ['cr-instance-describe'] }),
        ])
      }
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || err?.message || 'Failed to delete resource.'
      setDeleteError(String(detail))
    },
  })

  return {
    deleteDialogOpen,
    setDeleteDialogOpen,
    deleteError,
    setDeleteError,
    deleteMutation,
  }
}
