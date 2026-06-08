import { useState, useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useResourceDetail } from './ResourceDetailContext'
import { usePermission } from '@/hooks/usePermission'
import { useAIContext } from '@/hooks/useAIContext'
import { useModalStackEntry } from '@/hooks/useModalStack'
import { buildResourceLink } from '@/utils/resourceLink'
import { api } from '@/services/api'
import {
  TabId,
  WORKLOAD_KINDS,
  NETWORK_KINDS,
  CONFIG_STORAGE_KINDS,
  SELF_LOADING_KINDS,
  UNRESOLVABLE_KINDS,
  decodeSecretYaml,
  kindToPlural,
} from './resource-detail/utils'
import { useResourceDelete } from './resource-detail/useResourceDelete'
import { useResourceYaml } from './resource-detail/useResourceYaml'
import { ResourceDetailHeader } from './resource-detail/ResourceDetailHeader'
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
import ServiceAccountInfo from './resource-detail/ServiceAccountInfo'
import RoleInfo from './resource-detail/RoleInfo'
import RoleBindingInfo from './resource-detail/RoleBindingInfo'
import ClusterRoleInfo from './resource-detail/ClusterRoleInfo'
import ClusterRoleBindingInfo from './resource-detail/ClusterRoleBindingInfo'
import ConfigMapInfo from './resource-detail/ConfigMapInfo'
import SecretInfo from './resource-detail/SecretInfo'
import HPAInfo from './resource-detail/HPAInfo'
import VPAInfo from './resource-detail/VPAInfo'
import PDBInfo from './resource-detail/PDBInfo'
import PriorityClassInfo from './resource-detail/PriorityClassInfo'
import RuntimeClassInfo from './resource-detail/RuntimeClassInfo'
import LeaseInfo from './resource-detail/LeaseInfo'
import ResourceQuotaInfo from './resource-detail/ResourceQuotaInfo'
import LimitRangeInfo from './resource-detail/LimitRangeInfo'
import WebhookConfigInfo from './resource-detail/WebhookConfigInfo'
import CRDInfo from './resource-detail/CRDInfo'
import CustomResourceInstanceInfo from './resource-detail/CustomResourceInstanceInfo'
import GenericInfo from './resource-detail/GenericInfo'


export default function ResourceDetailDrawer() {
  const { t } = useTranslation()
  const { target, close, goBack, canGoBack } = useResourceDetail()
  const { isTop: isTopModal, zIndex } = useModalStackEntry(!!target)
  const [tab, setTab] = useState<TabId>('info')
  const [applyToast, setApplyToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const contentScrollRef = useRef<HTMLDivElement | null>(null)

  const ns = target?.namespace
  const name = target?.name ?? ''
  const kind = target?.kind ?? ''
  const { has } = usePermission()
  const canDelete = has(`resource.${kind.toLowerCase()}.delete`)

  const {
    deleteDialogOpen,
    setDeleteDialogOpen,
    deleteError,
    setDeleteError,
    deleteMutation,
  } = useResourceDelete({
    target: target ? { kind: target.kind, namespace: target.namespace ?? null, name: target.name, rawJson: (target as any).rawJson } : null,
    close,
  })
  const canEditYaml = has(`resource.${kind.toLowerCase()}.edit`)

  const {
    yamlData,
    yamlLoading,
    yamlFetching,
    yamlError,
    setYamlRefreshNonce,
    isYamlDirty,
    setIsYamlDirty,
    handleApplyYaml,
    invalidateAfterApply,
  } = useResourceYaml({
    target: target ? { kind: target.kind, namespace: target.namespace ?? null, name: target.name, rawJson: (target as any).rawJson } : null,
    tab,
    canEditYaml,
  })

  const needsRawJsonFetch = !!target
    && !target.rawJson
    && !SELF_LOADING_KINDS.has(kind)
    && !UNRESOLVABLE_KINDS.has(kind)
    && !!name

  const { data: fetchedRawJson } = useQuery({
    queryKey: ['resource-json', kind, ns, name],
    queryFn: () => api.getResourceJson(kindToPlural(kind), name, ns || undefined),
    enabled: needsRawJsonFetch,
    staleTime: 30_000,
    retry: 1,
  })

  const effectiveRawJson = target?.rawJson ?? fetchedRawJson


  // 플로팅 AI 위젯용 오버레이 스냅샷 (Info/YAML 2탭만)
  const aiSnapshot = useMemo(() => {
    if (!target) return null
    const link = buildResourceLink(kind, ns, name)
    const base = {
      kind,
      name,
      namespace: ns,
      active_tab: tab,
      ...(link ? { _link: link } : {}),
    }
    if (tab === 'yaml') {
      const yamlText = typeof yamlData?.yaml === 'string' ? yamlData.yaml : ''
      const truncated = yamlText.length > 4096 ? yamlText.slice(0, 4096) + '\n... (truncated) ...' : yamlText
      return {
        source: 'ResourceDetailDrawer' as const,
        summary: `${kind} ${name}${ns ? ` (${ns})` : ''} 상세 — YAML 탭`,
        data: { ...base, yaml: truncated },
      }
    }
    // info tab — effectiveRawJson 전체를 sanitize 후 통째로 포함.
    // managedFields / annotations 본문 등 대용량/잡음 필드는 제거.
    // 8KB 토큰 한도는 useAIContext 의 enforceTokenBudget 가 자동 적용.
    const rj = effectiveRawJson as Record<string, unknown> | undefined
    const meta = (rj?.metadata as Record<string, unknown> | undefined) ?? {}
    const sanitizedMeta = meta
      ? {
          ...meta,
          managedFields: undefined,
          annotations: meta.annotations
            ? Object.keys(meta.annotations as Record<string, unknown>)
            : undefined,
        }
      : meta
    const sanitizedRaw = rj ? { ...rj, metadata: sanitizedMeta } : undefined
    return {
      source: 'ResourceDetailDrawer' as const,
      summary: `${kind} ${name}${ns ? ` (${ns})` : ''} 상세 — Info 탭`,
      data: {
        ...base,
        raw: sanitizedRaw,
      },
    }
  }, [target, tab, kind, name, ns, yamlData, effectiveRawJson])

  useAIContext(aiSnapshot, [aiSnapshot])



  const confirmDiscardYaml = () => {
    if (!isYamlDirty) return true
    return window.confirm(t('common.yamlUnsaved', { defaultValue: 'You have unsaved YAML changes. Discard them?' }))
  }

  const resetDrawerState = () => {
    setTab('info')
    setIsYamlDirty(false)
    setApplyToast(null)
    setYamlRefreshNonce(0)
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

  useEffect(() => {
    if (!target) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 위에 중첩된 모달(예: Delete 확인)이 떠 있으면 그 모달이 처리해야 한다.
        if (!isTopModal()) return
        e.stopPropagation()
        handleClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [target, isYamlDirty, isTopModal])


  if (!target) return null

  const renderInfoContent = () => {
    if (kind === 'Node') return <NodeInfo name={name} />
    if (kind === 'Namespace') return <NamespaceInfo name={name} />
    if (kind === 'Pod' && ns) return <PodInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'Service' && ns) return <ServiceInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'Gateway' && ns) return <GatewayInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'GatewayClass') return <GatewayClassInfo name={name} rawJson={effectiveRawJson} />
    if (kind === 'HTTPRoute' && ns) return <HTTPRouteInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'GRPCRoute' && ns) return <GRPCRouteInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'ReferenceGrant' && ns) return <ReferenceGrantInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'BackendTLSPolicy' && ns) return <BackendTLSPolicyInfoComp name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'BackendTrafficPolicy' && ns) return <BackendTrafficPolicyInfoComp name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'DeviceClass') return <DeviceClassInfoComp name={name} rawJson={effectiveRawJson} />
    if (kind === 'ResourceClaim' && ns) return <ResourceClaimInfoComp name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'ResourceClaimTemplate' && ns) return <ResourceClaimTemplateInfoComp name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'ResourceSlice') return <ResourceSliceInfoComp name={name} rawJson={effectiveRawJson} />
    if (kind === 'ServiceAccount' && ns) return <ServiceAccountInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'Role' && ns) return <RoleInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'RoleBinding' && ns) return <RoleBindingInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'ClusterRole') return <ClusterRoleInfo name={name} rawJson={effectiveRawJson} />
    if (kind === 'ClusterRoleBinding') return <ClusterRoleBindingInfo name={name} rawJson={effectiveRawJson} />
    if (kind === 'ConfigMap' && ns) return <ConfigMapInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'Secret' && ns) return <SecretInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'HorizontalPodAutoscaler' && ns) return <HPAInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'VerticalPodAutoscaler' && ns) return <VPAInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'PodDisruptionBudget' && ns) return <PDBInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'PriorityClass') return <PriorityClassInfo name={name} rawJson={effectiveRawJson} />
    if (kind === 'RuntimeClass') return <RuntimeClassInfo name={name} rawJson={effectiveRawJson} />
    if (kind === 'Lease' && ns) return <LeaseInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'ResourceQuota' && ns) return <ResourceQuotaInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'LimitRange' && ns) return <LimitRangeInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (kind === 'MutatingWebhookConfiguration') return <WebhookConfigInfo name={name} kind="MutatingWebhookConfiguration" rawJson={effectiveRawJson} />
    if (kind === 'ValidatingWebhookConfiguration') return <WebhookConfigInfo name={name} kind="ValidatingWebhookConfiguration" rawJson={effectiveRawJson} />
    if (kind === 'CustomResourceDefinition') return <CRDInfo name={name} rawJson={effectiveRawJson} />
    if (kind === 'CustomResourceInstance') return <CustomResourceInstanceInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (WORKLOAD_KINDS.has(kind)) return <WorkloadInfo name={name} namespace={ns} kind={kind} rawJson={effectiveRawJson} />
    if (NETWORK_KINDS.has(kind)) return <NetworkInfo name={name} namespace={ns} kind={kind} rawJson={effectiveRawJson} />
    if (CONFIG_STORAGE_KINDS.has(kind)) return <ConfigStorageInfo name={name} namespace={ns} kind={kind} rawJson={effectiveRawJson} />
    return <GenericInfo name={name} namespace={ns} kind={kind} rawJson={effectiveRawJson} />
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/30"
        style={{ zIndex }}
        onClick={() => {
          // 위에 중첩된 모달이 떠 있으면 backdrop 클릭은 그 모달이 먹어야 한다.
          if (!isTopModal()) return
          handleClose()
        }}
      />
      <div
        className="fixed inset-y-0 right-0 w-full max-w-[740px] bg-slate-900 border-l border-slate-700 flex flex-col shadow-2xl"
        style={{ zIndex: zIndex + 1 }}
      >
        <ResourceDetailHeader
          kind={kind}
          ns={ns}
          name={name}
          effectiveRawJson={effectiveRawJson}
          canGoBack={canGoBack}
          canDelete={canDelete}
          tab={tab}
          onClose={handleClose}
          onGoBack={() => {
            if (!confirmDiscardYaml()) return
            resetDrawerState()
            goBack()
          }}
          onTabChange={handleTabChange}
          onDeleteClick={() => {
            setDeleteError(null)
            setDeleteDialogOpen(true)
          }}
          t={t}
        />

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
                value={kind === 'Secret' && canEditYaml && yamlData?.yaml ? decodeSecretYaml(yamlData.yaml) : yamlData?.yaml || ''}
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
              {`Delete ${kind}`}
            </h3>
            <p className="text-sm text-slate-300 mb-4">
              {ns
                ? `Are you sure you want to delete ${kind} "${name}" in "${ns}"?`
                : `Are you sure you want to delete ${kind} "${name}"?`}
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
