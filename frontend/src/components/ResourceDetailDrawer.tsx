import { useState, useCallback, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { X, Info, FileCode, Trash2 } from 'lucide-react'
import { useResourceDetail } from './ResourceDetailContext'
import { api } from '@/services/api'
import YamlEditor from './YamlEditor'
import { ModalOverlay } from './ModalOverlay'

import NodeInfo from './resource-detail/NodeInfo'
import NamespaceInfo from './resource-detail/NamespaceInfo'
import PodInfo from './resource-detail/PodInfo'
import WorkloadInfo from './resource-detail/WorkloadInfo'
import NetworkInfo from './resource-detail/NetworkInfo'
import ServiceInfo from './resource-detail/ServiceInfo'
import GatewayInfo from './resource-detail/GatewayInfo'
import GatewayClassInfo from './resource-detail/GatewayClassInfo'
import HTTPRouteInfo from './resource-detail/HTTPRouteInfo'
import GRPCRouteInfo from './resource-detail/GRPCRouteInfo'
import ReferenceGrantInfo from './resource-detail/ReferenceGrantInfo'
import BackendTLSPolicyInfoComp from './resource-detail/BackendTLSPolicyInfo'
import BackendTrafficPolicyInfoComp from './resource-detail/BackendTrafficPolicyInfo'
import DeviceClassInfoComp from './resource-detail/DeviceClassInfo'
import ResourceClaimInfoComp from './resource-detail/ResourceClaimInfo'
import ResourceClaimTemplateInfoComp from './resource-detail/ResourceClaimTemplateInfo'
import ResourceSliceInfoComp from './resource-detail/ResourceSliceInfo'
import ConfigStorageInfo from './resource-detail/ConfigStorageInfo'
import GenericInfo from './resource-detail/GenericInfo'

type TabId = 'info' | 'yaml'

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'])
const NETWORK_KINDS = new Set(['Ingress', 'IngressClass', 'NetworkPolicy', 'Endpoints', 'EndpointSlice'])
const CONFIG_STORAGE_KINDS = new Set(['ConfigMap', 'Secret', 'PersistentVolume', 'PersistentVolumeClaim', 'StorageClass', 'VolumeAttachment', 'HorizontalPodAutoscaler'])

function kindToPlural(kind: string): string {
  const map: Record<string, string> = {
    Pod: 'pod', Node: 'node', Namespace: 'namespace', Service: 'service',
    Deployment: 'deployment', ReplicaSet: 'replicaset', StatefulSet: 'statefulset',
    DaemonSet: 'daemonset', Job: 'job', CronJob: 'cronjob',
    ConfigMap: 'configmap', Secret: 'secret', Ingress: 'ingress',
    NetworkPolicy: 'networkpolicy', PersistentVolumeClaim: 'persistentvolumeclaim',
    PersistentVolume: 'persistentvolume', HorizontalPodAutoscaler: 'horizontalpodautoscaler',
    Endpoints: 'endpoints', EndpointSlice: 'endpointslice',
    IngressClass: 'ingressclass',
    Gateway: 'gateway',
    GatewayClass: 'gatewayclass',
    HTTPRoute: 'httproute',
    GRPCRoute: 'grpcroute',
    ReferenceGrant: 'referencegrant',
    BackendTLSPolicy: 'backendtlspolicy',
    BackendTrafficPolicy: 'backendtrafficpolicy',
    DeviceClass: 'deviceclass',
    ResourceClaim: 'resourceclaim',
    ResourceClaimTemplate: 'resourceclaimtemplate',
    ResourceSlice: 'resourceslice',
    StorageClass: 'storageclass',
    VolumeAttachment: 'volumeattachment',
  }
  return map[kind] ?? kind.toLowerCase()
}

function kindIcon(kind: string): string {
  const map: Record<string, string> = {
    Node: '🖥️', Namespace: '📦', Pod: '🔵', Deployment: '🚀', StatefulSet: '📊',
    DaemonSet: '👾', ReplicaSet: '📋', Job: '⚡', CronJob: '⏰',
    Service: '🌐', Ingress: '🔀', NetworkPolicy: '🛡️',
    IngressClass: '🧩',
    EndpointSlice: '🧩',
    Gateway: '🚪',
    GatewayClass: '🚏',
    HTTPRoute: '🧭',
    GRPCRoute: '📡',
    ReferenceGrant: '🔗',
    BackendTLSPolicy: '🔒',
    BackendTrafficPolicy: '🚦',
    DeviceClass: '🎮',
    ResourceClaim: '📋',
    ResourceClaimTemplate: '📄',
    ResourceSlice: '🧩',
    ConfigMap: '📝', Secret: '🔑', PersistentVolume: '💾', PersistentVolumeClaim: '💿',
    StorageClass: '🗄️', VolumeAttachment: '🔗', HorizontalPodAutoscaler: '📈',
  }
  return map[kind] ?? '📄'
}

export default function ResourceDetailDrawer() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { target, close } = useResourceDetail()
  const [tab, setTab] = useState<TabId>('info')
  const [yamlRefreshNonce, setYamlRefreshNonce] = useState(0)
  const [isYamlDirty, setIsYamlDirty] = useState(false)
  const [applyToast, setApplyToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const contentScrollRef = useRef<HTMLDivElement | null>(null)

  const ns = target?.namespace
  const name = target?.name ?? ''
  const kind = target?.kind ?? ''

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 30000, enabled: !!target })
  const isAdmin = me?.role === 'admin'
  const isWriteRole = me?.role === 'admin' || me?.role === 'write'
  const canEditYaml = kind === 'Node' ? isAdmin : isWriteRole
  const canDeleteNode = kind === 'Node' && isAdmin
  const canDeletePod = kind === 'Pod' && !!ns && isWriteRole
  const canDeleteNamespace = kind === 'Namespace' && isWriteRole
  const canDeleteDeployment = kind === 'Deployment' && !!ns && isWriteRole
  const canDeleteStatefulSet = kind === 'StatefulSet' && !!ns && isWriteRole
  const canDeleteDaemonSet = kind === 'DaemonSet' && !!ns && isWriteRole
  const canDeleteJob = kind === 'Job' && !!ns && isWriteRole
  const canDeleteReplicaSet = kind === 'ReplicaSet' && !!ns && isWriteRole
  const canDeleteCronJob = kind === 'CronJob' && !!ns && isWriteRole
  const canDeletePVC = kind === 'PersistentVolumeClaim' && !!ns && isWriteRole
  const canDeletePV = kind === 'PersistentVolume' && isWriteRole
  const canDeleteStorageClass = kind === 'StorageClass' && isWriteRole
  const canDeleteVolumeAttachment = kind === 'VolumeAttachment' && isWriteRole
  const canDeleteService = kind === 'Service' && !!ns && isWriteRole
  const canDeleteIngress = kind === 'Ingress' && !!ns && isWriteRole
  const canDeleteIngressClass = kind === 'IngressClass' && isWriteRole
  const canDeleteNetworkPolicy = kind === 'NetworkPolicy' && !!ns && isWriteRole
  const canDeleteGateway = kind === 'Gateway' && !!ns && isWriteRole
  const canDeleteGatewayClass = kind === 'GatewayClass' && isWriteRole
  const canDeleteHTTPRoute = kind === 'HTTPRoute' && !!ns && isWriteRole
  const canDeleteGRPCRoute = kind === 'GRPCRoute' && !!ns && isWriteRole
  const canDeleteReferenceGrant = kind === 'ReferenceGrant' && !!ns && isWriteRole
  const canDeleteBackendTLSPolicy = kind === 'BackendTLSPolicy' && !!ns && isWriteRole
  const canDeleteBackendTrafficPolicy = kind === 'BackendTrafficPolicy' && !!ns && isWriteRole
  const canDeleteEndpoints = kind === 'Endpoints' && !!ns && isWriteRole
  const canDeleteEndpointSlice = kind === 'EndpointSlice' && !!ns && isWriteRole
  const canDeleteDeviceClass = kind === 'DeviceClass' && isWriteRole
  const canDeleteResourceClaim = kind === 'ResourceClaim' && !!ns && isWriteRole
  const canDeleteResourceClaimTemplate = kind === 'ResourceClaimTemplate' && !!ns && isWriteRole
  const canDeleteResourceSlice = kind === 'ResourceSlice' && isWriteRole
  const canDelete = [
    canDeleteNode,
    canDeletePod,
    canDeleteNamespace,
    canDeleteDeployment,
    canDeleteStatefulSet,
    canDeleteDaemonSet,
    canDeleteJob,
    canDeleteReplicaSet,
    canDeleteCronJob,
    canDeletePVC,
    canDeletePV,
    canDeleteStorageClass,
    canDeleteVolumeAttachment,
    canDeleteService,
    canDeleteIngress,
    canDeleteIngressClass,
    canDeleteNetworkPolicy,
    canDeleteGateway,
    canDeleteGatewayClass,
    canDeleteHTTPRoute,
    canDeleteGRPCRoute,
    canDeleteReferenceGrant,
    canDeleteBackendTLSPolicy,
    canDeleteBackendTrafficPolicy,
    canDeleteEndpoints,
    canDeleteEndpointSlice,
    canDeleteDeviceClass,
    canDeleteResourceClaim,
    canDeleteResourceClaimTemplate,
    canDeleteResourceSlice,
  ].some(Boolean)

  const { data: yamlData, isLoading: yamlLoading, isFetching: yamlFetching, isError: yamlError } = useQuery({
    queryKey: ['resource-yaml', kind, ns, name, yamlRefreshNonce],
    queryFn: async () => {
      if (kind === 'Node') return api.getNodeYaml(name, yamlRefreshNonce > 0)
      if (kind === 'Namespace') return api.getNamespaceYaml(name, yamlRefreshNonce > 0)
      return api.getResourceYaml(kindToPlural(kind), name, ns || undefined)
    },
    enabled: !!target && tab === 'yaml',
    staleTime: 10_000,
    retry: 1,
  })

  const handleApplyYaml = async (yaml: string) => {
    if (kind === 'Node') await api.applyNodeYaml(name, yaml)
    else if (kind === 'Namespace') await api.applyNamespaceYaml(name, yaml)
    else await api.applyResourceYaml(kindToPlural(kind), name, yaml, ns || undefined)
  }

  const invalidateAfterApply = useCallback(() => {
    setYamlRefreshNonce(prev => prev + 1)
    queryClient.invalidateQueries({ queryKey: ['resource-yaml'] })
    if (kind === 'Node') {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes'] })
      queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'describe', name] })
      queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'pods', name] })
      queryClient.invalidateQueries({ queryKey: ['cluster', 'node-metrics'] })
    } else if (kind === 'Namespace') {
      queryClient.invalidateQueries({ queryKey: ['namespace-describe', name] })
      queryClient.invalidateQueries({ queryKey: ['namespaces'] })
      queryClient.invalidateQueries({ queryKey: ['namespace-resource-quotas', name] })
      queryClient.invalidateQueries({ queryKey: ['namespace-limit-ranges', name] })
    } else if (kind === 'Pod') {
      queryClient.invalidateQueries({ queryKey: ['pod-describe', ns, name] })
      queryClient.invalidateQueries({ queryKey: ['cluster', 'pods'] })
    } else if (kind === 'PersistentVolumeClaim' && ns) {
      queryClient.invalidateQueries({ queryKey: ['storage', 'pvcs'] })
      queryClient.invalidateQueries({ queryKey: ['storage', 'pvcs', ns] })
      queryClient.invalidateQueries({ queryKey: ['pvc-describe', ns, name] })
    } else if (kind === 'PersistentVolume') {
      queryClient.invalidateQueries({ queryKey: ['storage', 'pvs'] })
      queryClient.invalidateQueries({ queryKey: ['pv-describe', name] })
    } else if (kind === 'StorageClass') {
      queryClient.invalidateQueries({ queryKey: ['storage', 'storageclasses'] })
      queryClient.invalidateQueries({ queryKey: ['storageclass-describe', name] })
    } else if (kind === 'VolumeAttachment') {
      queryClient.invalidateQueries({ queryKey: ['storage', 'volumeattachments'] })
      queryClient.invalidateQueries({ queryKey: ['volumeattachment-describe', name] })
    } else if (kind === 'Endpoints' && ns) {
      queryClient.invalidateQueries({ queryKey: ['network', 'endpoints'] })
      queryClient.invalidateQueries({ queryKey: ['network', 'endpoints', ns] })
      queryClient.invalidateQueries({ queryKey: ['endpoint-describe', ns, name] })
    } else if (kind === 'EndpointSlice' && ns) {
      queryClient.invalidateQueries({ queryKey: ['network', 'endpointslices'] })
      queryClient.invalidateQueries({ queryKey: ['network', 'endpointslices', ns] })
      queryClient.invalidateQueries({ queryKey: ['endpointslice-describe', ns, name] })
    } else if (kind === 'Ingress' && ns) {
      queryClient.invalidateQueries({ queryKey: ['network', 'ingresses'] })
      queryClient.invalidateQueries({ queryKey: ['network', 'ingresses', ns] })
      queryClient.invalidateQueries({ queryKey: ['ingress-detail', ns, name] })
    } else if (kind === 'IngressClass') {
      queryClient.invalidateQueries({ queryKey: ['network', 'ingressclasses'] })
      queryClient.invalidateQueries({ queryKey: ['ingressclass-describe', name] })
    } else if (kind === 'NetworkPolicy' && ns) {
      queryClient.invalidateQueries({ queryKey: ['network', 'networkpolicies'] })
      queryClient.invalidateQueries({ queryKey: ['network', 'networkpolicies', ns] })
      queryClient.invalidateQueries({ queryKey: ['networkpolicy-describe', ns, name] })
    } else if (kind === 'Gateway' && ns) {
      queryClient.invalidateQueries({ queryKey: ['gateway', 'gateways'] })
      queryClient.invalidateQueries({ queryKey: ['gateway', 'gateways', ns] })
      queryClient.invalidateQueries({ queryKey: ['gateway-describe', ns, name] })
    } else if (kind === 'GatewayClass') {
      queryClient.invalidateQueries({ queryKey: ['gateway', 'gatewayclasses'] })
      queryClient.invalidateQueries({ queryKey: ['gatewayclass-describe', name] })
    } else if (kind === 'HTTPRoute' && ns) {
      queryClient.invalidateQueries({ queryKey: ['gateway', 'httproutes'] })
      queryClient.invalidateQueries({ queryKey: ['gateway', 'httproutes', ns] })
      queryClient.invalidateQueries({ queryKey: ['httproute-describe', ns, name] })
    } else if (kind === 'GRPCRoute' && ns) {
      queryClient.invalidateQueries({ queryKey: ['gateway', 'grpcroutes'] })
      queryClient.invalidateQueries({ queryKey: ['gateway', 'grpcroutes', ns] })
      queryClient.invalidateQueries({ queryKey: ['grpcroute-describe', ns, name] })
    } else if (kind === 'ReferenceGrant' && ns) {
      queryClient.invalidateQueries({ queryKey: ['gateway', 'referencegrants'] })
      queryClient.invalidateQueries({ queryKey: ['gateway', 'referencegrants', ns] })
      queryClient.invalidateQueries({ queryKey: ['referencegrant-describe', ns, name] })
    } else if (kind === 'BackendTLSPolicy' && ns) {
      queryClient.invalidateQueries({ queryKey: ['gateway', 'backendtlspolicies'] })
      queryClient.invalidateQueries({ queryKey: ['gateway', 'backendtlspolicies', ns] })
      queryClient.invalidateQueries({ queryKey: ['backendtlspolicy-describe', ns, name] })
    } else if (kind === 'BackendTrafficPolicy' && ns) {
      queryClient.invalidateQueries({ queryKey: ['gateway', 'backendtrafficpolicies'] })
      queryClient.invalidateQueries({ queryKey: ['gateway', 'backendtrafficpolicies', ns] })
      queryClient.invalidateQueries({ queryKey: ['backendtrafficpolicy-describe', ns, name] })
    } else if (kind === 'DeviceClass') {
      queryClient.invalidateQueries({ queryKey: ['gpu', 'deviceclasses'] })
      queryClient.invalidateQueries({ queryKey: ['deviceclass-describe', name] })
    } else if (kind === 'ResourceClaim' && ns) {
      queryClient.invalidateQueries({ queryKey: ['gpu', 'resourceclaims'] })
      queryClient.invalidateQueries({ queryKey: ['resourceclaim-describe', ns, name] })
    } else if (kind === 'ResourceClaimTemplate' && ns) {
      queryClient.invalidateQueries({ queryKey: ['gpu', 'resourceclaimtemplates'] })
      queryClient.invalidateQueries({ queryKey: ['resourceclaimtemplate-describe', ns, name] })
    } else if (kind === 'ResourceSlice') {
      queryClient.invalidateQueries({ queryKey: ['gpu', 'resourceslices'] })
      queryClient.invalidateQueries({ queryKey: ['resourceslice-describe', name] })
    } else {
      queryClient.invalidateQueries({ queryKey: ['search-resources'] })
    }
  }, [queryClient, kind, ns, name])

  const confirmDiscardYaml = () => {
    if (!isYamlDirty) return true
    return window.confirm(t('common.yamlUnsaved', { defaultValue: 'You have unsaved YAML changes. Discard them?' }))
  }

  const resetDrawerState = () => {
    setTab('info')
    setIsYamlDirty(false)
    setApplyToast(null)
    setYamlRefreshNonce(0)
    setDeleteDialogOpen(false)
    setDeleteError(null)
  }

  const handleClose = () => {
    if (!confirmDiscardYaml()) return
    close()
    resetDrawerState()
  }

  const handleTabChange = (next: TabId) => {
    if (tab === next) return
    if (tab === 'yaml' && !confirmDiscardYaml()) return
    setTab(next)
  }

  useEffect(() => {
    if (!target) return
    const el = contentScrollRef.current
    if (!el) return
    el.scrollTop = 0
    el.scrollLeft = 0
  }, [target?.kind, target?.namespace, target?.name, tab])

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
      if (kind === 'BackendTrafficPolicy' && ns) {
        await api.deleteBackendTrafficPolicy(ns, name)
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
      throw new Error('Delete is not supported for this resource.')
    },
    onSuccess: async () => {
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
      } else if (kind === 'BackendTrafficPolicy' && ns) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['gateway', 'backendtrafficpolicies'] }),
          queryClient.invalidateQueries({ queryKey: ['gateway', 'backendtrafficpolicies', ns] }),
          queryClient.invalidateQueries({ queryKey: ['backendtrafficpolicy-describe', ns, name] }),
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
      }

      close()
      resetDrawerState()
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || err?.message || 'Failed to delete resource.'
      setDeleteError(String(detail))
    },
  })

  if (!target) return null

  const renderInfoContent = () => {
    if (kind === 'Node') return <NodeInfo name={name} />
    if (kind === 'Namespace') return <NamespaceInfo name={name} />
    if (kind === 'Pod' && ns) return <PodInfo name={name} namespace={ns} rawJson={target.rawJson} />
    if (kind === 'Service' && ns) return <ServiceInfo name={name} namespace={ns} rawJson={target.rawJson} />
    if (kind === 'Gateway' && ns) return <GatewayInfo name={name} namespace={ns} rawJson={target.rawJson} />
    if (kind === 'GatewayClass') return <GatewayClassInfo name={name} rawJson={target.rawJson} />
    if (kind === 'HTTPRoute' && ns) return <HTTPRouteInfo name={name} namespace={ns} rawJson={target.rawJson} />
    if (kind === 'GRPCRoute' && ns) return <GRPCRouteInfo name={name} namespace={ns} rawJson={target.rawJson} />
    if (kind === 'ReferenceGrant' && ns) return <ReferenceGrantInfo name={name} namespace={ns} rawJson={target.rawJson} />
    if (kind === 'BackendTLSPolicy' && ns) return <BackendTLSPolicyInfoComp name={name} namespace={ns} rawJson={target.rawJson} />
    if (kind === 'BackendTrafficPolicy' && ns) return <BackendTrafficPolicyInfoComp name={name} namespace={ns} rawJson={target.rawJson} />
    if (kind === 'DeviceClass') return <DeviceClassInfoComp name={name} rawJson={target.rawJson} />
    if (kind === 'ResourceClaim' && ns) return <ResourceClaimInfoComp name={name} namespace={ns} rawJson={target.rawJson} />
    if (kind === 'ResourceClaimTemplate' && ns) return <ResourceClaimTemplateInfoComp name={name} namespace={ns} rawJson={target.rawJson} />
    if (kind === 'ResourceSlice') return <ResourceSliceInfoComp name={name} rawJson={target.rawJson} />
    if (WORKLOAD_KINDS.has(kind)) return <WorkloadInfo name={name} namespace={ns} kind={kind} rawJson={target.rawJson} />
    if (NETWORK_KINDS.has(kind)) return <NetworkInfo name={name} namespace={ns} kind={kind} rawJson={target.rawJson} />
    if (CONFIG_STORAGE_KINDS.has(kind)) return <ConfigStorageInfo name={name} namespace={ns} kind={kind} rawJson={target.rawJson} />
    return <GenericInfo name={name} namespace={ns} kind={kind} rawJson={target.rawJson} />
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-[998]" onClick={handleClose} />
      <div className="fixed inset-y-0 right-0 w-full max-w-[740px] bg-slate-900 border-l border-slate-700 z-[999] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-700 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm">{kindIcon(kind)}</span>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300 font-medium">{kind}</span>
              {ns && <span className="text-xs text-slate-500">{ns}</span>}
            </div>
            <h2 className="text-lg font-semibold text-white truncate">{name}</h2>
          </div>
          <button onClick={handleClose} className="text-slate-400 hover:text-white p-1 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center justify-between px-5 py-2 border-b border-slate-800 text-xs shrink-0 gap-2">
          <div className="flex items-center gap-2">
            {([
              { id: 'info' as TabId, label: t('common.info', { defaultValue: 'Info' }), icon: Info },
              { id: 'yaml' as TabId, label: 'YAML', icon: FileCode },
            ]).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => handleTabChange(id)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md border transition-colors ${
                  tab === id
                    ? 'border-slate-500 bg-slate-800 text-white'
                    : 'border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
          {canDelete && (
            <button
              type="button"
              onClick={() => {
                setDeleteError(null)
                setDeleteDialogOpen(true)
              }}
              className="flex items-center gap-1.5 px-3 py-1 rounded-md border border-red-700/60 bg-red-900/20 text-red-300 hover:bg-red-900/40"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {kind === 'Node'
                ? t('nodes.delete.button', { defaultValue: 'Delete Node' })
                : kind === 'Pod'
                ? t('pods.delete', { defaultValue: 'Delete Pod' })
                : kind === 'Deployment'
                  ? t('deployments.delete.button', { defaultValue: 'Delete Deployment' })
                  : kind === 'StatefulSet'
                    ? t('statefulsets.delete.button', { defaultValue: 'Delete StatefulSet' })
                    : kind === 'DaemonSet'
                      ? t('daemonsets.delete.button', { defaultValue: 'Delete DaemonSet' })
                      : kind === 'Job'
                        ? t('jobs.delete.button', { defaultValue: 'Delete Job' })
                      : kind === 'ReplicaSet'
                        ? t('replicasets.delete.button', { defaultValue: 'Delete ReplicaSet' })
                      : kind === 'CronJob'
                        ? t('cronjobs.delete.button', { defaultValue: 'Delete CronJob' })
                      : kind === 'PersistentVolumeClaim'
                        ? t('pvcs.delete.button', { defaultValue: 'Delete PVC' })
                      : kind === 'PersistentVolume'
                        ? t('pvs.delete.button', { defaultValue: 'Delete PV' })
                      : kind === 'StorageClass'
                        ? t('storageclasses.delete.button', { defaultValue: 'Delete StorageClass' })
                      : kind === 'VolumeAttachment'
                        ? t('volumeattachments.delete.button', { defaultValue: 'Delete VolumeAttachment' })
                      : kind === 'Service'
                        ? t('servicesPage.delete.button', { defaultValue: 'Delete Service' })
                      : kind === 'Endpoints'
                        ? t('endpointsPage.delete.button', { defaultValue: 'Delete Endpoints' })
                      : kind === 'EndpointSlice'
                        ? t('endpointSlicesPage.delete.button', { defaultValue: 'Delete EndpointSlice' })
                      : kind === 'Ingress'
                        ? t('ingressesPage.delete.button', { defaultValue: 'Delete Ingress' })
                      : kind === 'IngressClass'
                        ? t('ingressClassesPage.delete.button', { defaultValue: 'Delete IngressClass' })
                      : kind === 'NetworkPolicy'
                        ? t('networkPoliciesPage.delete.button', { defaultValue: 'Delete NetworkPolicy' })
                      : kind === 'Gateway'
                        ? t('gatewaysPage.delete.button', { defaultValue: 'Delete Gateway' })
                      : kind === 'GatewayClass'
                        ? t('gatewayClassesPage.delete.button', { defaultValue: 'Delete GatewayClass' })
                      : kind === 'HTTPRoute'
                        ? t('httpRoutesPage.delete.button', { defaultValue: 'Delete HTTPRoute' })
                      : kind === 'GRPCRoute'
                        ? t('grpcRoutesPage.delete.button', { defaultValue: 'Delete GRPCRoute' })
                      : kind === 'ReferenceGrant'
                        ? t('referenceGrantsPage.delete.button', { defaultValue: 'Delete ReferenceGrant' })
                      : kind === 'DeviceClass'
                        ? t('deviceClassesPage.delete.button', { defaultValue: 'Delete DeviceClass' })
                      : kind === 'ResourceClaim'
                        ? t('resourceClaimsPage.delete.button', { defaultValue: 'Delete ResourceClaim' })
                      : kind === 'ResourceClaimTemplate'
                        ? t('resourceClaimTemplatesPage.delete.button', { defaultValue: 'Delete ResourceClaimTemplate' })
                      : kind === 'ResourceSlice'
                        ? t('resourceSlicesPage.delete.button', { defaultValue: 'Delete ResourceSlice' })
                  : t('namespaces.delete.button', { defaultValue: 'Delete Namespace' })}
            </button>
          )}
        </div>

        {/* Content */}
        <div ref={contentScrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
          {tab === 'info' && (
            <div className="p-5 space-y-6 text-sm">
              {renderInfoContent()}
            </div>
          )}

          {tab === 'yaml' && (
            <div className="h-full">
              <YamlEditor
                key={`${kind}-${name}-${ns || ''}`}
                value={yamlData?.yaml || ''}
                canEdit={canEditYaml}
                isLoading={yamlLoading}
                isRefreshing={yamlFetching}
                error={yamlError ? t('common.yamlError', { defaultValue: 'Failed to load YAML.' }) : null}
                onRefresh={() => setYamlRefreshNonce(prev => prev + 1)}
                onApply={canEditYaml ? handleApplyYaml : undefined}
                onApplySuccess={() => { invalidateAfterApply(); setApplyToast({ type: 'success', message: t('common.applied', { defaultValue: 'Applied' }) }) }}
                onApplyError={(msg) => setApplyToast({ type: 'error', message: msg || t('common.applyError', { defaultValue: 'Apply failed.' }) })}
                onDirtyChange={setIsYamlDirty}
                showInlineApplied={false}
                toast={applyToast}
                labels={{
                  title: `${kind}: ${name}`,
                  refresh: t('common.refresh', { defaultValue: 'Refresh' }),
                  copy: t('common.copy', { defaultValue: 'Copy' }),
                  edit: t('common.edit', { defaultValue: 'Edit' }),
                  apply: t('common.apply', { defaultValue: 'Apply' }),
                  applying: t('common.applying', { defaultValue: 'Applying...' }),
                  cancel: t('common.cancel', { defaultValue: 'Cancel' }),
                  loading: t('common.loading', { defaultValue: 'Loading...' }),
                  error: t('common.error', { defaultValue: 'Error' }),
                  readonly: t('common.readonly', { defaultValue: 'Read-only' }),
                  editHint: t('common.editHint', { defaultValue: 'Edit YAML' }),
                  applied: t('common.applied', { defaultValue: 'Applied' }),
                  refreshing: t('common.refreshing', { defaultValue: 'Refreshing...' }),
                }}
              />
            </div>
          )}
        </div>
      </div>

      {deleteDialogOpen && (
        <ModalOverlay onClose={() => { if (!deleteMutation.isPending) setDeleteDialogOpen(false) }}>
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-full max-w-md mx-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-2">
              {kind === 'Node'
                ? t('nodes.delete.title', { defaultValue: 'Delete Node' })
                : kind === 'Pod'
                ? t('pods.deleteTitle', { defaultValue: 'Delete Pod' })
                : kind === 'Deployment'
                  ? t('deployments.delete.title', { defaultValue: 'Delete Deployment' })
                  : kind === 'StatefulSet'
                    ? t('statefulsets.delete.title', { defaultValue: 'Delete StatefulSet' })
                    : kind === 'DaemonSet'
                      ? t('daemonsets.delete.title', { defaultValue: 'Delete DaemonSet' })
                      : kind === 'Job'
                        ? t('jobs.delete.title', { defaultValue: 'Delete Job' })
                      : kind === 'ReplicaSet'
                        ? t('replicasets.delete.title', { defaultValue: 'Delete ReplicaSet' })
                      : kind === 'CronJob'
                        ? t('cronjobs.delete.title', { defaultValue: 'Delete CronJob' })
                      : kind === 'PersistentVolumeClaim'
                        ? t('pvcs.delete.title', { defaultValue: 'Delete PVC' })
                      : kind === 'PersistentVolume'
                        ? t('pvs.delete.title', { defaultValue: 'Delete PV' })
                      : kind === 'StorageClass'
                        ? t('storageclasses.delete.title', { defaultValue: 'Delete StorageClass' })
                      : kind === 'VolumeAttachment'
                        ? t('volumeattachments.delete.title', { defaultValue: 'Delete VolumeAttachment' })
                      : kind === 'Service'
                        ? t('servicesPage.delete.title', { defaultValue: 'Delete Service' })
                      : kind === 'Endpoints'
                        ? t('endpointsPage.delete.title', { defaultValue: 'Delete Endpoints' })
                      : kind === 'EndpointSlice'
                        ? t('endpointSlicesPage.delete.title', { defaultValue: 'Delete EndpointSlice' })
                      : kind === 'Ingress'
                        ? t('ingressesPage.delete.title', { defaultValue: 'Delete Ingress' })
                      : kind === 'IngressClass'
                        ? t('ingressClassesPage.delete.title', { defaultValue: 'Delete IngressClass' })
                      : kind === 'NetworkPolicy'
                        ? t('networkPoliciesPage.delete.title', { defaultValue: 'Delete NetworkPolicy' })
                      : kind === 'Gateway'
                        ? t('gatewaysPage.delete.title', { defaultValue: 'Delete Gateway' })
                      : kind === 'GatewayClass'
                        ? t('gatewayClassesPage.delete.title', { defaultValue: 'Delete GatewayClass' })
                      : kind === 'HTTPRoute'
                        ? t('httpRoutesPage.delete.title', { defaultValue: 'Delete HTTPRoute' })
                      : kind === 'GRPCRoute'
                        ? t('grpcRoutesPage.delete.title', { defaultValue: 'Delete GRPCRoute' })
                      : kind === 'ReferenceGrant'
                        ? t('referenceGrantsPage.delete.title', { defaultValue: 'Delete ReferenceGrant' })
                      : kind === 'DeviceClass'
                        ? t('deviceClassesPage.delete.title', { defaultValue: 'Delete DeviceClass' })
                      : kind === 'ResourceClaim'
                        ? t('resourceClaimsPage.delete.title', { defaultValue: 'Delete ResourceClaim' })
                      : kind === 'ResourceClaimTemplate'
                        ? t('resourceClaimTemplatesPage.delete.title', { defaultValue: 'Delete ResourceClaimTemplate' })
                      : kind === 'ResourceSlice'
                        ? t('resourceSlicesPage.delete.title', { defaultValue: 'Delete ResourceSlice' })
                  : t('namespaces.delete.title', { defaultValue: 'Delete Namespace' })}
            </h3>
            <p className="text-sm text-slate-300 mb-4">
              {kind === 'Node'
                ? t('nodes.delete.confirm', {
                    defaultValue: 'Are you sure you want to delete node "{{name}}"?',
                    name,
                  })
                : kind === 'Pod'
                ? t('pods.deleteConfirm', {
                    defaultValue: 'Are you sure you want to delete pod "{{name}}" in "{{namespace}}"?',
                    name,
                    namespace: ns,
                  })
                : kind === 'Deployment'
                  ? t('deployments.delete.confirm', {
                      defaultValue: 'Are you sure you want to delete deployment "{{name}}" in "{{namespace}}"?',
                      name,
                      namespace: ns,
                    })
                  : kind === 'StatefulSet'
                    ? t('statefulsets.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete StatefulSet "{{name}}" in "{{namespace}}"?',
                        name,
                        namespace: ns,
                      })
                  : kind === 'DaemonSet'
                    ? t('daemonsets.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete DaemonSet "{{name}}" in "{{namespace}}"?',
                        name,
                        namespace: ns,
                      })
                  : kind === 'Job'
                    ? t('jobs.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete Job "{{name}}" in "{{namespace}}"?',
                        name,
                        namespace: ns,
                      })
                  : kind === 'ReplicaSet'
                    ? t('replicasets.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete ReplicaSet "{{name}}" in "{{namespace}}"?',
                        name,
                        namespace: ns,
                      })
                  : kind === 'CronJob'
                    ? t('cronjobs.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete CronJob "{{name}}" in "{{namespace}}"?',
                        name,
                        namespace: ns,
                      })
                  : kind === 'PersistentVolumeClaim'
                    ? t('pvcs.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete PVC "{{name}}" in "{{namespace}}"?',
                        name,
                        namespace: ns,
                      })
                  : kind === 'PersistentVolume'
                    ? t('pvs.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete PV "{{name}}"?',
                        name,
                      })
                  : kind === 'StorageClass'
                    ? t('storageclasses.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete StorageClass "{{name}}"?',
                        name,
                      })
                  : kind === 'VolumeAttachment'
                    ? t('volumeattachments.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete VolumeAttachment "{{name}}"?',
                        name,
                      })
                  : kind === 'Service'
                    ? t('servicesPage.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete service "{{name}}" in "{{namespace}}"?',
                        name,
                        namespace: ns,
                      })
                  : kind === 'Endpoints'
                    ? t('endpointsPage.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete endpoints "{{name}}" in "{{namespace}}"?',
                        name,
                        namespace: ns,
                      })
                  : kind === 'EndpointSlice'
                    ? t('endpointSlicesPage.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete endpoint slice "{{name}}" in "{{namespace}}"?',
                        name,
                        namespace: ns,
                      })
                  : kind === 'Ingress'
                    ? t('ingressesPage.delete.confirm', {
                        defaultValue: 'Are you sure you want to delete ingress "{{name}}" in "{{namespace}}"?',
                        name,
                        namespace: ns,
                      })
                      : kind === 'IngressClass'
                        ? t('ingressClassesPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete ingress class "{{name}}"?',
                            name,
                          })
                      : kind === 'NetworkPolicy'
                        ? t('networkPoliciesPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete network policy "{{name}}" in "{{namespace}}"?',
                            name,
                            namespace: ns,
                          })
                      : kind === 'Gateway'
                        ? t('gatewaysPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete gateway "{{name}}" in "{{namespace}}"?',
                            name,
                            namespace: ns,
                          })
                      : kind === 'GatewayClass'
                        ? t('gatewayClassesPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete gateway class "{{name}}"?',
                            name,
                          })
                      : kind === 'HTTPRoute'
                        ? t('httpRoutesPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete HTTPRoute "{{name}}" in "{{namespace}}"?',
                            name,
                            namespace: ns,
                          })
                      : kind === 'GRPCRoute'
                        ? t('grpcRoutesPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete GRPCRoute "{{name}}" in "{{namespace}}"?',
                            name,
                            namespace: ns,
                          })
                      : kind === 'ReferenceGrant'
                        ? t('referenceGrantsPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete ReferenceGrant "{{name}}" in "{{namespace}}"?',
                            name,
                            namespace: ns,
                          })
                      : kind === 'DeviceClass'
                        ? t('deviceClassesPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete DeviceClass "{{name}}"?',
                            name,
                          })
                      : kind === 'ResourceClaim'
                        ? t('resourceClaimsPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete ResourceClaim "{{name}}" in "{{namespace}}"?',
                            name,
                            namespace: ns,
                          })
                      : kind === 'ResourceClaimTemplate'
                        ? t('resourceClaimTemplatesPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete ResourceClaimTemplate "{{name}}" in "{{namespace}}"?',
                            name,
                            namespace: ns,
                          })
                      : kind === 'ResourceSlice'
                        ? t('resourceSlicesPage.delete.confirm', {
                            defaultValue: 'Are you sure you want to delete ResourceSlice "{{name}}"?',
                            name,
                          })
                  : t('namespaces.delete.confirm', {
                      defaultValue: 'Are you sure you want to delete namespace "{{name}}"?',
                      name,
                  })}
            </p>
            {kind === 'Node' && (
              <p className="text-xs text-red-400 mb-4 p-2 bg-red-500/10 border border-red-500/20 rounded-lg">
                {t('nodes.delete.warning', {
                  defaultValue: 'Deleting a node can disrupt workloads scheduled on it.',
                })}
              </p>
            )}
            {kind === 'Namespace' && (
              <p className="text-xs text-red-400 mb-4 p-2 bg-red-500/10 border border-red-500/20 rounded-lg">
                {t('namespaces.delete.warning', {
                  defaultValue: 'All resources in this namespace will be permanently deleted.',
                })}
              </p>
            )}
            {deleteError && <p className="text-sm text-red-400 mb-3">{deleteError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteDialogOpen(false)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-800 disabled:opacity-50"
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
              >
                {deleteMutation.isPending
                  ? t('common.deleting', { defaultValue: 'Deleting...' })
                  : t('common.delete', { defaultValue: 'Delete' })}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </>
  )
}
