// 리소스 YAML 편집 hook. ResourceDetailDrawer.tsx 에서 추출 (Phase 3.3.c).
//
// useQuery (yaml fetch) + nonce-based 강제 갱신 + dirty 상태 + apply + invalidate.
// invalidateAfterApply 는 kind 별로 다른 query cache 를 invalidate (~150줄).

import i18next from 'i18next'
import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '@/services/api'

import { drawerResourceType, objectResourceType } from './crDetail'
import { encodeSecretYaml, yamlOpenedOf } from './utils'

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

  // a custom resource by its CRD's name (plural.group): another CRD may serve an object of the same namespace and name,
  // so the key names it too and the read of one is never the other's YAML
  const type = target ? objectResourceType(target) : ''
  const { data: yamlData, isLoading: yamlLoading, isFetching: yamlFetching, error: yamlError } = useQuery({
    queryKey: ['resource-yaml', kind, ns, name, type, yamlRefreshNonce],
    queryFn: async () => {
      if (kind === 'Node') return api.getNodeYaml(name, yamlRefreshNonce > 0)
      if (kind === 'Namespace') return api.getNamespaceYaml(name, yamlRefreshNonce > 0)
      if (kind === 'Secret' && ns) return api.getSecretYaml(ns, name)
      if (kind === 'CustomResourceDefinition') return api.getResourceYaml('customresourcedefinitions', name, undefined)
      return api.getResourceYaml(type, name, ns || undefined)
    },
    enabled: !!target && tab === 'yaml',
    staleTime: 10_000,
    retry: 1,
  })

  // Answers how many of a Secret's masked values the server left as they were, and whether the object was already
  // as the text says (kubectl apply's "unchanged": the server wrote nothing).
  const handleApplyYaml = async (rawYaml: string, opened?: string): Promise<{ kept: number; unchanged: boolean }> => {
    const asSaved = (text: string) => (kind === 'Secret' && canEditYaml ? encodeSecretYaml(text) : text)
    const yaml = asSaved(rawYaml)
    // what left this text leaves the object: a merge patch alone would leave what it does not name
    const began = opened === undefined ? undefined : yamlOpenedOf(asSaved(opened), yaml)
    let answer: { unchanged?: boolean; kept_masked?: string[] } | undefined
    if (kind === 'Node') answer = await api.applyNodeYaml(name, yaml, began)
    else if (kind === 'Namespace') answer = await api.applyNamespaceYaml(name, yaml, began)
    else if (kind === 'CustomResourceDefinition') answer = await api.applyResourceYaml('customresourcedefinitions', name, yaml, undefined, began)
    else if (kind === 'CustomResourceInstance') {
      const rj = target?.rawJson as Record<string, unknown> | undefined
      const crdN = (rj?.crd_name as string) || ''
      // with no CRD to name it by nothing would be sent, which must not read as applied
      if (!crdN) throw new Error(i18next.t('common.yamlNoCrd', { defaultValue: 'This custom resource does not name its CustomResourceDefinition, so it cannot be saved here.' }))
      answer = await api.applyResourceYaml(crdN, name, yaml, ns || undefined, began)
    }
    else answer = await api.applyResourceYaml(drawerResourceType(kind), name, yaml, ns || undefined, began)
    return { kept: answer?.kept_masked?.length ?? 0, unchanged: answer?.unchanged === true }
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
      queryClient.invalidateQueries({ queryKey: ['namespace-rq', name] })
      queryClient.invalidateQueries({ queryKey: ['namespace-lr', name] })
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
      queryClient.invalidateQueries({ queryKey: ['endpoints-describe', ns, name] })
    } else if (kind === 'EndpointSlice' && ns) {
      queryClient.invalidateQueries({ queryKey: ['network', 'endpointslices'] })
      queryClient.invalidateQueries({ queryKey: ['network', 'endpointslices', ns] })
      queryClient.invalidateQueries({ queryKey: ['endpointslice-describe', ns, name] })
    } else if (kind === 'Ingress' && ns) {
      queryClient.invalidateQueries({ queryKey: ['network', 'ingresses'] })
      queryClient.invalidateQueries({ queryKey: ['network', 'ingresses', ns] })
      queryClient.invalidateQueries({ queryKey: ['ingress-describe', ns, name] })
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
    } else if (kind === 'ValidatingAdmissionPolicy' || kind === 'MutatingAdmissionPolicy') {
      queryClient.invalidateQueries({ queryKey: ['cluster', kind === 'ValidatingAdmissionPolicy' ? 'validatingadmissionpolicies' : 'mutatingadmissionpolicies'] })
      queryClient.invalidateQueries({ queryKey: ['admissionpolicy-describe', kind, name] })
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
