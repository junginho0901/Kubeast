import { useState, useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useResourceDetail } from './ResourceDetailContext'
import { useCanI } from '@/hooks/useCanCreate'
import { usePermission } from '@/hooks/usePermission'
import { permResource } from '@/utils/permissions'
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
} from './resource-detail/utils'
import { useResourceDelete } from './resource-detail/useResourceDelete'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { argoAppUrl, detectArgoApp } from './resource-detail/gitops'
import { useResourceYaml } from './resource-detail/useResourceYaml'
import { ResourceDetailHeader } from './resource-detail/ResourceDetailHeader'
import YamlEditor from './YamlEditor'
import { ModalFrame } from './ModalFrame'
import { modalButton } from './modalStyles'
import { TypeToConfirm, WarningBox } from './TypeToConfirm'
import { systemObject, type SystemReason } from './resource-detail/systemObject'
import { customResourceTarget, deleteTarget, drawerResourceType, needsCustomResourceLookup } from './resource-detail/crDetail'
import { drawerObjectLayer, followsObjectForChat, objectReadInterval } from './resource-detail/drawerObjectLayer'
import { drawerBody, useDrawerFollowsRead } from './resource-detail/useDrawerFollowsRead'
import { DrawerObjectReadContext } from './resource-detail/drawerObjectRead'
import { ObjectUnreadable } from './resource-detail/DetailCommon'
import { useConfirm } from '@/services/confirm'

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
import AdmissionPolicyInfo from './resource-detail/AdmissionPolicyInfo'
import CRDInfo from './resource-detail/CRDInfo'
import CustomResourceInstanceInfo from './resource-detail/CustomResourceInstanceInfo'
import GenericInfo from './resource-detail/GenericInfo'
import PolicyViolations from './resource-detail/PolicyViolations'
import { violationsAfterInfo, violationsApiVersion } from './resource-detail/violationsView'
import { failureText } from '@/utils/failureText'

const SYSTEM_REASON_EN: Record<SystemReason, string> = {
  immortalNamespace: 'Kubernetes keeps this namespace.',
  systemNamespace: 'It belongs to a Kubernetes system namespace (kube-system, kube-public, kube-node-lease).',
  node: 'It is a node of the cluster.',
  crd: 'Deleting a CustomResourceDefinition deletes every object of its kind.',
  helm: 'Helm manages it: the next upgrade recreates it or the release drifts.',
  bootstrap: 'It is part of the Kubernetes default RBAC (kubernetes.io/bootstrapping).',
  systemRbac: 'It is a system permission (system:*, cluster-admin).',
}

export default function ResourceDetailDrawer() {
  const { t } = useTranslation()
  const { target: asked, close, goBack, canGoBack } = useResourceDetail()
  // An object named with an apiVersion of another group than its Kind's drawer (a second group's Widget, opened from
  // Advanced Search, the Timeline or a link) is a custom resource when a CRD of that group serves the Kind.
  const crLookup = !!asked && needsCustomResourceLookup(asked)
  const { data: crds, isLoading: crdsLoading } = useQuery({
    queryKey: ['custom-resources', 'crds'],
    queryFn: () => api.getCRDs(false),
    enabled: crLookup,
    staleTime: 60_000,
    retry: false,
  })
  const resolving = crLookup && crdsLoading
  const target = useMemo(() => (asked && crLookup ? customResourceTarget(asked, crds) : asked), [asked, crLookup, crds])
  const { isTop: isTopModal, zIndex } = useModalStackEntry(!!target)
  const [tab, setTab] = useState<TabId>('info')
  const [applyToast, setApplyToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const contentScrollRef = useRef<HTMLDivElement | null>(null)

  const ns = target?.namespace
  const name = target?.name ?? ''
  const kind = target?.kind ?? ''
  // The generic custom-resource drawer shows the object's own kind when the caller passes it.
  const crKind = kind === 'CustomResourceInstance' ? target?.rawJson?.kind : undefined
  const displayKind = typeof crKind === 'string' && crKind ? crKind : kind
  // Admission policies are read-only in Kubeast (no delete route); the YAML tab is the shared path.
  const readOnlyKind = kind === 'ValidatingAdmissionPolicy' || kind === 'MutatingAdmissionPolicy'
  // the cluster's answer too, as the create buttons: the Write role's edit cannot delete cluster-scoped objects,
  // Roles, Endpoints or quotas; hidden while a custom resource's CRD is looked up and while the cluster is asked
  const mayDelete = useCanI(`resource.${permResource(kind)}.delete`, 'delete',
    readOnlyKind || resolving ? undefined : deleteTarget(kind, ns, name, target?.rawJson))
  const canDelete = !readOnlyKind && !resolving && mayDelete

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
  const features = useClusterFeatures().data
  // features.admissionPolicies.readOnly: the server refuses a policy apply, so the editor stays read-only too.
  const policyLocked = !!features?.admissionPolicies?.readOnly &&
    ['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'MutatingAdmissionPolicy', 'MutatingAdmissionPolicyBinding'].includes(kind)
  // the cluster's and the server's answer for this object, as Delete above
  const mayEdit = useCanI(`resource.${permResource(kind)}.edit`, 'patch',
    readOnlyKind || resolving ? undefined : deleteTarget(kind, ns, name, target?.rawJson))
  const canEditYaml = mayEdit && !policyLocked
  const { has: hasPermission } = usePermission()

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

  // The Argo CD guard reads annotations, which the list pages' summarized
  // rawJson does not carry: fetch the full object for the badge when needed.
  const argoCfg = features?.gitops?.argocd
  const rawJsonLacksAnnotations = !!target?.rawJson && !((target.rawJson as Record<string, unknown>).metadata as Record<string, unknown> | undefined)?.annotations
  // the delete window's system-object check reads labels and annotations too
  const needsRawJsonFetch = !!target && !resolving
    && (!target.rawJson || ((!!argoCfg?.enabled || deleteDialogOpen) && rawJsonLacksAnnotations))
    && !SELF_LOADING_KINDS.has(kind)
    && !UNRESOLVABLE_KINDS.has(kind)
    && !!name

  // The floating chat is told the object as it is now, not the row the list had when the drawer opened. A view inside that
  // watches its object reads this when the object changes; without a watch that answers it is read on the clock.
  const followsForChat = !!target && tab === 'info' && !resolving && !!name && followsObjectForChat(kind)
  const [objectWatchAnswers, setObjectWatchAnswers] = useState(false)
  const objectKey = useMemo(() => ['resource-json', kind, ns, name], [kind, ns, name])
  const objectRead = useMemo(() => (followsForChat ? { key: objectKey, setWatchAnswers: setObjectWatchAnswers } : null), [followsForChat, objectKey])
  const { data: fetchedRawJson, dataUpdatedAt: rawJsonReadAt, isFetching: rawJsonFetching, error: rawJsonError } = useQuery({
    queryKey: objectKey,
    queryFn: () => api.getResourceJson(drawerResourceType(kind), name, ns || undefined),
    enabled: needsRawJsonFetch || followsForChat,
    staleTime: 30_000,
    refetchInterval: (query) => objectReadInterval(followsForChat, query.state.error, objectWatchAnswers),
    // 403 and 404 are answers: the notice comes now, not a second later after asking again
    retry: (failures, error) => failures < 1 && ![403, 404].includes((error as { response?: { status?: number } }).response?.status ?? 0),
  })

  // The body follows the read above, which goes on for the floating chat: no request of its own, none while nothing changes.
  const effectiveRawJson = useMemo(() => drawerBody(kind, target?.rawJson, fetchedRawJson, rawJsonReadAt, target?.openedAt),
    [kind, target?.rawJson, fetchedRawJson, rawJsonReadAt, target?.openedAt])
  useDrawerFollowsRead(kind, ns, name, fetchedRawJson)
  // Opened by link with nothing from a list: an object that is gone (404) or out of the caller's reach (403) says
  // so, instead of an empty object with a delete button.
  const loadStatus = needsRawJsonFetch && !target?.rawJson ? (rawJsonError as { response?: { status?: number } } | null)?.response?.status : undefined
  const unreadable = loadStatus === 403 || loadStatus === 404
  // ...and its Delete waits for that read, so a gone or refused object does not flash one
  const linkPending = needsRawJsonFetch && !target?.rawJson && fetchedRawJson === undefined && !rawJsonError
  // Argo CD guard: an object an Application manages is badged; in block mode
  // the console's write buttons are off (k8s-service refuses them anyway).
  const argoManaged = detectArgoApp((fetchedRawJson ?? effectiveRawJson) as Record<string, unknown> | undefined, kind, argoCfg)
  const argoBlocked = !!argoManaged && argoCfg?.mode === 'block'
  const argo = argoCfg?.enabled ? { managed: argoManaged, url: argoManaged ? argoAppUrl(argoCfg, argoManaged.app) : null, blocked: argoBlocked } : undefined
  const argoWarnText = t('common.gitops.confirm', { app: argoManaged?.app ?? '', defaultValue: 'Argo CD application "{{app}}" manages this object; a change made here is reverted on the next sync. Change it in Git instead. Continue anyway?' })
  const confirm = useConfirm()
  const keptMaskedRef = useRef(0)
  const handleApplyYamlGuarded = async (rawYaml: string, opened: string) => {
    keptMaskedRef.current = 0
    if (argoManaged && !argoBlocked && !(await confirm({ title: t('common.gitops.confirmTitle', { defaultValue: 'Managed by Argo CD' }), message: argoWarnText, confirmLabel: t('common.gitops.applyAnyway', { defaultValue: 'Apply anyway' }) }))) return false
    keptMaskedRef.current = await handleApplyYaml(rawYaml, opened)
    return true
  }

  // re-QA #38: system objects ask for the name; the namespaces the API server keeps get a notice
  const system = systemObject(kind, ns, name, ((fetchedRawJson ?? effectiveRawJson) as { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> } } | undefined)?.metadata)
  const systemMetaPending = deleteDialogOpen && rawJsonLacksAnnotations && !fetchedRawJson && rawJsonFetching
  const [typedName, setTypedName] = useState('')


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
    // A Secret's values never go to the model, even from a user who may reveal
    // them on screen; the server strips them again (defense in depth).
    const isSecret = kind.toLowerCase() === 'secret'
    if (tab === 'yaml') {
      const yamlText = isSecret ? '' : typeof yamlData?.yaml === 'string' ? yamlData.yaml : ''
      const truncated = yamlText.length > 4096 ? yamlText.slice(0, 4096) + '\n... (truncated) ...' : yamlText
      return {
        source: 'ResourceDetailDrawer' as const,
        summary: `${kind} ${name}${ns ? ` (${ns})` : ''} 상세 — YAML 탭`,
        data: { ...base, yaml: isSecret ? '(secret data omitted)' : truncated },
      }
    }
    // info tab
    return {
      source: 'ResourceDetailDrawer' as const,
      summary: `${kind} ${name}${ns ? ` (${ns})` : ''} 상세 — Info 탭`,
      data: {
        ...base,
        ...drawerObjectLayer({
          row: target.rawJson,
          live: fetchedRawJson,
          secret: isSecret,
          readStatus: (rawJsonError as { response?: { status?: number } } | null)?.response?.status,
        }),
      },
    }
  }, [target, tab, kind, name, ns, yamlData, fetchedRawJson, rawJsonError])

  useAIContext(aiSnapshot, [aiSnapshot])
  useAIContext(deleteDialogOpen && target ? {
    source: 'DeleteConfirm',
    summary: `삭제 확인 창 — ${displayKind} ${ns ? `${ns}/` : ''}${name}`,
    data: { action: 'delete', kind: displayKind, namespace: ns, name, error: deleteError || undefined },
  } : null, [deleteDialogOpen, target, displayKind, ns, name, deleteError])



  const confirmDiscardYaml = async () => {
    if (!isYamlDirty) return true
    return confirm({
      title: t('common.yamlUnsavedTitle', { defaultValue: 'Unsaved YAML' }),
      message: t('common.yamlUnsaved', { defaultValue: 'You have unsaved YAML changes. Discard them?' }),
      confirmLabel: t('common.discard', { defaultValue: 'Discard' }),
      danger: true,
    })
  }

  const resetDrawerState = () => {
    setTab('info')
    setIsYamlDirty(false)
    setApplyToast(null)
    setYamlRefreshNonce(0)
  }

  const handleClose = async () => {
    if (!(await confirmDiscardYaml())) return
    close()
    resetDrawerState()
  }
  // The keydown effect reads the latest handler through a ref, so the listener
  // is not re-registered on every render.
  const handleCloseRef = useRef(handleClose)
  useEffect(() => {
    handleCloseRef.current = handleClose
  })

  const handleTabChange = async (next: TabId) => {
    if (tab === next) return
    if (tab === 'yaml' && !(await confirmDiscardYaml())) return
    setTab(next)
  }

  const hasTarget = !!target
  useEffect(() => {
    if (!hasTarget) return
    const el = contentScrollRef.current
    if (!el) return
    el.scrollTop = 0
    el.scrollLeft = 0
  }, [hasTarget, target?.kind, target?.namespace, target?.name, tab])

  useEffect(() => {
    if (!target) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 위에 중첩된 모달(예: Delete 확인)이 떠 있으면 그 모달이 처리해야 한다.
        if (!isTopModal()) return
        e.stopPropagation()
        handleCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [target, isYamlDirty, isTopModal])


  if (!target) return null

  const renderInfoContent = () => {
    if (resolving) return <p className="text-slate-400">{t('common.loading', 'Loading...')}</p>
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
    if (kind === 'ValidatingAdmissionPolicy') return <AdmissionPolicyInfo name={name} kind="ValidatingAdmissionPolicy" />
    if (kind === 'MutatingAdmissionPolicy') return <AdmissionPolicyInfo name={name} kind="MutatingAdmissionPolicy" />
    if (kind === 'CustomResourceDefinition') return <CRDInfo name={name} rawJson={effectiveRawJson} />
    if (kind === 'CustomResourceInstance') return <CustomResourceInstanceInfo name={name} namespace={ns} rawJson={effectiveRawJson} />
    if (WORKLOAD_KINDS.has(kind)) return <WorkloadInfo name={name} namespace={ns} kind={kind} rawJson={effectiveRawJson} writesBlocked={argoBlocked} />
    if (NETWORK_KINDS.has(kind)) return <NetworkInfo name={name} namespace={ns} kind={kind} rawJson={effectiveRawJson} />
    if (CONFIG_STORAGE_KINDS.has(kind)) return <ConfigStorageInfo name={name} namespace={ns} kind={kind} rawJson={effectiveRawJson} />
    // the other views load what they show; this one shows only the object, so it waits for the object
    if (linkPending) return <p className="text-slate-400">{t('common.loading', 'Loading...')}</p>
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
          displayKind={displayKind}
          ns={ns}
          name={name}
          effectiveRawJson={effectiveRawJson}
          canGoBack={canGoBack}
          canDelete={canDelete && !argoBlocked && !unreadable && !linkPending}
          argo={argo}
          tab={tab}
          onClose={handleClose}
          onGoBack={async () => {
            if (!(await confirmDiscardYaml())) return
            resetDrawerState()
            goBack()
          }}
          onTabChange={handleTabChange}
          onDeleteClick={() => {
            setDeleteError(null)
            setTypedName('')
            setDeleteDialogOpen(true)
          }}
          t={t}
        />

        {/* Content */}
        <div ref={contentScrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
          {tab === 'info' && (
            <DrawerObjectReadContext.Provider value={objectRead}>
            <div className="p-5 space-y-6 text-sm">
              {unreadable ? (
                <ObjectUnreadable kind={displayKind} name={name} namespace={ns} notFound={loadStatus === 404} />
              ) : renderInfoContent()}
              {!unreadable && !resolving && !linkPending && violationsAfterInfo(kind, ns) && <PolicyViolations kind={displayKind} namespace={ns ?? ''} name={name} apiVersion={violationsApiVersion(kind, target?.rawJson)} />}
            </div>
            </DrawerObjectReadContext.Provider>
          )}

          {tab === 'yaml' && (
            <div className="h-full">
              <YamlEditor
                key={`${kind}-${name}-${ns || ''}`}
                value={kind === 'Secret' && canEditYaml && yamlData?.yaml ? decodeSecretYaml(yamlData.yaml) : yamlData?.yaml || ''}
                canEdit={canEditYaml && !argoBlocked && !unreadable}
                isLoading={yamlLoading}
                isRefreshing={yamlFetching}
                error={yamlError ? `${t('common.yamlError', { defaultValue: 'Failed to load YAML.' })} ${failureText(yamlError)}` : null}
                onRefresh={() => setYamlRefreshNonce(prev => prev + 1)}
                onApply={canEditYaml && !argoBlocked && !unreadable ? handleApplyYamlGuarded : undefined}
                onApplySuccess={() => {
                  invalidateAfterApply()
                  const kept = keptMaskedRef.current
                  setApplyToast({ type: 'success', message: kept > 0 ? t('secretInfo.appliedKeptMasked', { count: kept, defaultValue: 'Applied. Hidden values left as they were: {{count}}' }) : t('common.applied', { defaultValue: 'Applied' }) })
                }}
                onApplyError={(msg) => setApplyToast({ type: 'error', message: msg || t('common.applyError', { defaultValue: 'Apply failed.' }) })}
                onDirtyChange={setIsYamlDirty}
                showInlineApplied={false}
                toast={applyToast}
                note={kind === 'Secret' && canEditYaml && !argoBlocked && !unreadable && !hasPermission('resource.secret.reveal') ? t('secretInfo.yamlMaskedNote', { defaultValue: 'A value shown as *** stays as it is when you save, as long as its line is there. To change one, write the new value over it. To remove one, delete its line.' }) : undefined}
                labels={{
                  title: `${displayKind}: ${name}`,
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
        <ModalFrame
          size="sm"
          title={t('common.deleteKind', { kind: displayKind, defaultValue: 'Delete {{kind}}' })}
          onClose={() => setDeleteDialogOpen(false)}
          busy={deleteMutation.isPending}
          testId="delete-dialog"
          footer={system.blocked ? (
            <button type="button" className={modalButton.cancel} onClick={() => setDeleteDialogOpen(false)}>
              {t('common.close', { defaultValue: 'Close' })}
            </button>
          ) : (
            <>
              <button type="button" className={modalButton.cancel} onClick={() => setDeleteDialogOpen(false)} disabled={deleteMutation.isPending}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                data-testid="delete-dialog-confirm"
                className={modalButton.danger}
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending || systemMetaPending || (system.reasons.length > 0 && typedName !== name)}
              >
                {deleteMutation.isPending
                  ? t('common.deleting', { defaultValue: 'Deleting...' })
                  : t('common.delete', { defaultValue: 'Delete' })}
              </button>
            </>
          )}
        >
          {system.blocked ? (
            <p className="text-sm text-slate-300 break-keep" data-testid="delete-refused">
              {t('common.deleteRefused', { kind: displayKind, name, defaultValue: 'Kubernetes does not allow deleting {{kind}} "{{name}}".' })}
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-300 break-keep">
                {ns
                  // `ns` is i18next's namespace option, so the value goes in as `namespace`
                  ? t('common.deleteKindConfirmNs', { kind: displayKind, name, namespace: ns, defaultValue: 'Are you sure you want to delete {{kind}} "{{name}}" in "{{namespace}}"?' })
                  : t('common.deleteKindConfirm', { kind: displayKind, name, defaultValue: 'Are you sure you want to delete {{kind}} "{{name}}"?' })}
              </p>
              {argoManaged && !argoBlocked && (
                <p className="mt-3 text-xs text-amber-300 p-2 bg-amber-500/10 border border-amber-500/20 rounded-lg break-keep">{argoWarnText}</p>
              )}
              {kind === 'Node' && (
                <WarningBox>{t('nodes.delete.warning', { defaultValue: 'Deleting a node can disrupt workloads scheduled on it.' })}</WarningBox>
              )}
              {kind === 'Namespace' && (
                <WarningBox>{t('namespaces.delete.warning', { defaultValue: 'All resources in this namespace will be permanently deleted.' })}</WarningBox>
              )}
              {system.reasons.length > 0 && (
                <>
                  <WarningBox>
                    {[t('common.systemObject.title', { defaultValue: 'This is a system object.' }),
                      ...system.reasons.map((r) => `· ${t(`common.systemObject.${r}`, { defaultValue: SYSTEM_REASON_EN[r] })}`)].join('\n')}
                  </WarningBox>
                  <TypeToConfirm expected={name} value={typedName} onChange={setTypedName} />
                </>
              )}
            </>
          )}
          {deleteError && <p className="mt-3 text-sm text-red-400 break-keep">{deleteError}</p>}
        </ModalFrame>
      )}
    </>
  )
}
