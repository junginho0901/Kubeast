// 리소스 YAML 편집 hook. ResourceDetailDrawer.tsx 에서 추출 (Phase 3.3.c).
//
// useQuery (yaml fetch) + nonce-based 강제 갱신 + dirty 상태 + apply + invalidate.
// invalidateAfterApply 는 kind 별로 다른 query cache 를 invalidate (~150줄).

import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '@/services/api'

import { kindToPlural, encodeSecretYaml } from './utils'

interface Target {
  kind: string
  namespace: string | null | undefined
  name: string
  rawJson?: any
}

interface Args {
  target: Target | null
  tab: 'info' | 'yaml'
  canEditYaml: boolean
}

export function useResourceYaml({ target, tab, canEditYaml }: Args) {
  const queryClient = useQueryClient()
  const [yamlRefreshNonce, setYamlRefreshNonce] = useState(0)
  const [isYamlDirty, setIsYamlDirty] = useState(false)

  const kind = target?.kind ?? ''
  const ns = target?.namespace ?? null
  const name = target?.name ?? ''

  const { data: yamlData, isLoading: yamlLoading, isFetching: yamlFetching, isError: yamlError } = useQuery({
    queryKey: ['resource-yaml', kind, ns, name, yamlRefreshNonce],
    queryFn: async () => {
      if (kind === 'Node') return api.getNodeYaml(name, yamlRefreshNonce > 0)
      if (kind === 'Namespace') return api.getNamespaceYaml(name, yamlRefreshNonce > 0)
      if (kind === 'Secret' && ns) return api.getSecretYaml(ns, name)
      if (kind === 'CustomResourceDefinition') return api.getResourceYaml('customresourcedefinitions', name, undefined)
      if (kind === 'CustomResourceInstance') {
        const rj = target?.rawJson as Record<string, unknown> | undefined
        const crdN = (rj?.crd_name as string) || ''
        const plural = crdN ? crdN.split('.')[0] : ''
        if (plural) return api.getResourceYaml(plural, name, ns || undefined)
      }
      return api.getResourceYaml(kindToPlural(kind), name, ns || undefined)
    },
    enabled: !!target && tab === 'yaml',
    staleTime: 10_000,
    retry: 1,
  })

  const handleApplyYaml = async (rawYaml: string) => {
    const yaml = kind === 'Secret' && canEditYaml ? encodeSecretYaml(rawYaml) : rawYaml
    if (kind === 'Node') await api.applyNodeYaml(name, yaml)
    else if (kind === 'Namespace') await api.applyNamespaceYaml(name, yaml)
    else if (kind === 'CustomResourceDefinition') await api.applyResourceYaml('customresourcedefinitions', name, yaml, undefined)
    else if (kind === 'CustomResourceInstance') {
      const rj = target?.rawJson as Record<string, unknown> | undefined
      const crdN = (rj?.crd_name as string) || ''
      const plural = crdN ? crdN.split('.')[0] : ''
      if (plural) await api.applyResourceYaml(plural, name, yaml, ns || undefined)
    }
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
    } else if (kind === 'ServiceAccount' && ns) {
      queryClient.invalidateQueries({ queryKey: ['security', 'serviceaccounts'] })
      queryClient.invalidateQueries({ queryKey: ['security', 'serviceaccounts', ns] })
      queryClient.invalidateQueries({ queryKey: ['serviceaccount-describe', ns, name] })
    } else if (kind === 'Role' && ns) {
      queryClient.invalidateQueries({ queryKey: ['security', 'roles'] })
      queryClient.invalidateQueries({ queryKey: ['security', 'roles', ns] })
      queryClient.invalidateQueries({ queryKey: ['role-describe', ns, name] })
    } else if (kind === 'RoleBinding' && ns) {
      queryClient.invalidateQueries({ queryKey: ['security', 'rolebindings'] })
      queryClient.invalidateQueries({ queryKey: ['security', 'rolebindings', ns] })
      queryClient.invalidateQueries({ queryKey: ['rolebinding-describe', ns, name] })
    } else if (kind === 'ClusterRole') {
      queryClient.invalidateQueries({ queryKey: ['security', 'clusterroles'] })
      queryClient.invalidateQueries({ queryKey: ['clusterrole-describe', name] })
    } else if (kind === 'ClusterRoleBinding') {
      queryClient.invalidateQueries({ queryKey: ['security', 'clusterrolebindings'] })
      queryClient.invalidateQueries({ queryKey: ['clusterrolebinding-describe', name] })
    } else if (kind === 'ConfigMap' && ns) {
      queryClient.invalidateQueries({ queryKey: ['configuration', 'configmaps'] })
      queryClient.invalidateQueries({ queryKey: ['configuration', 'configmaps', ns] })
      queryClient.invalidateQueries({ queryKey: ['configmap-describe', ns, name] })
    } else if (kind === 'Secret' && ns) {
      queryClient.invalidateQueries({ queryKey: ['configuration', 'secrets'] })
      queryClient.invalidateQueries({ queryKey: ['configuration', 'secrets', ns] })
      queryClient.invalidateQueries({ queryKey: ['secret-describe', ns, name] })
    } else if (kind === 'PodDisruptionBudget' && ns) {
      queryClient.invalidateQueries({ queryKey: ['workloads', 'pdbs'] })
      queryClient.invalidateQueries({ queryKey: ['workloads', 'pdbs', ns] })
      queryClient.invalidateQueries({ queryKey: ['pdb-describe', ns, name] })
    } else if (kind === 'PriorityClass') {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'priorityclasses'] })
      queryClient.invalidateQueries({ queryKey: ['priorityclass-describe', name] })
    } else if (kind === 'RuntimeClass') {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'runtimeclasses'] })
      queryClient.invalidateQueries({ queryKey: ['runtimeclass-describe', name] })
    } else if (kind === 'Lease' && ns) {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'leases'] })
      queryClient.invalidateQueries({ queryKey: ['cluster', 'leases', ns] })
      queryClient.invalidateQueries({ queryKey: ['lease-describe', ns, name] })
    } else if (kind === 'ResourceQuota' && ns) {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'resourcequotas'] })
      queryClient.invalidateQueries({ queryKey: ['cluster', 'resourcequotas', ns] })
      queryClient.invalidateQueries({ queryKey: ['resourcequota-describe', ns, name] })
    } else if (kind === 'LimitRange' && ns) {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'limitranges'] })
      queryClient.invalidateQueries({ queryKey: ['cluster', 'limitranges', ns] })
      queryClient.invalidateQueries({ queryKey: ['limitrange-describe', ns, name] })
    } else if (kind === 'MutatingWebhookConfiguration') {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'mutatingwebhookconfigurations'] })
      queryClient.invalidateQueries({ queryKey: ['mutatingwebhookconfiguration-describe', name] })
    } else if (kind === 'ValidatingWebhookConfiguration') {
      queryClient.invalidateQueries({ queryKey: ['cluster', 'validatingwebhookconfigurations'] })
      queryClient.invalidateQueries({ queryKey: ['validatingwebhookconfiguration-describe', name] })
    } else if (kind === 'CustomResourceDefinition') {
      queryClient.invalidateQueries({ queryKey: ['custom-resources', 'crds'] })
      queryClient.invalidateQueries({ queryKey: ['crd-describe', name] })
    } else if (kind === 'CustomResourceInstance') {
      queryClient.invalidateQueries({ queryKey: ['custom-resources', 'instances'] })
      queryClient.invalidateQueries({ queryKey: ['cr-instance-describe'] })
    } else {
      queryClient.invalidateQueries({ queryKey: ['search-resources'] })
    }
  }, [queryClient, kind, ns, name])

  return {
    yamlData,
    yamlLoading,
    yamlFetching,
    yamlError,
    yamlRefreshNonce,
    setYamlRefreshNonce,
    isYamlDirty,
    setIsYamlDirty,
    handleApplyYaml,
    invalidateAfterApply,
  }
}
