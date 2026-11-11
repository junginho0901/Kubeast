import { useState } from 'react'
import { useCanI } from '@/hooks/useCanCreate'
import { deleteTarget } from './crDetail'
import { useTranslation } from 'react-i18next'
import { InfoSection, InfoRow, KeyValueTags, ConditionsTable, EventsSection } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { ResourceLink } from './ResourceLink'
import { boolText, formatToleration } from './workload-info/workloadInfoFormatters'
import { useWorkloadData } from './workload-info/useWorkloadData'
import WorkloadReplicasSection from './workload-info/WorkloadReplicasSection'
import WorkloadStrategySection from './workload-info/WorkloadStrategySection'
import PolicyViolations from './PolicyViolations'
import { violationsApiVersion } from './violationsView'
import NetworkPolicies from './NetworkPolicies'
import NetworkFlows from './NetworkFlows'
import NetworkDrops from './NetworkDrops'
import TopTalkers from './TopTalkers'
import { LogSearchView } from '@/components/LogSearchView'
import { useLogSearchAvailable } from '@/hooks/useLogSearchAvailable'
import WorkloadKindInfo from './workload-info/WorkloadKindInfo'
import WorkloadOwnedResources from './workload-info/WorkloadOwnedResources'
import WorkloadContainers from './workload-info/WorkloadContainers'
import WorkloadAffinity from './workload-info/WorkloadAffinity'
import WorkloadDialogs from './workload-info/WorkloadDialogs'
import { DescribeFailure } from './DescribeFailure'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
  /** Argo CD manages the object in block mode: no rollback button (the server refuses it, 409) */
  writesBlocked?: boolean
}

// Kinds whose pods the log search can name from the workload (the controller's pod name pattern).
const LOG_SEARCH_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']
// Kinds with a pod template the NetworkPolicy view reads (k8s-service netpolKinds).
const NETPOL_KINDS = new Set(LOG_SEARCH_KINDS)

export default function WorkloadInfo({ name, namespace, kind, rawJson, writesBlocked = false }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, o?: Record<string, any>) => t(key, { defaultValue: fallback, ...o })
  const logSearchAvailable = useLogSearchAvailable()
  // Each search is an audited read: the section searches once opened, not when the drawer opens.
  const [logSearchOpen, setLogSearchOpen] = useState(false)

  const data = useWorkloadData({ name, namespace, kind, rawJson })

  const {
    describe,
    isLoading,
    describeError,
    needsDescribe,
    ownedJobs,
    owned,
    revisions,
    suspendMut,
    triggerMut,
    rollbackMut,
    triggerDialogOpen,
    setTriggerDialogOpen,
    triggerToast,
    setTriggerToast,
    rollbackDialogOpen,
    setRollbackDialogOpen,
    selectedRevision,
    setSelectedRevision,
    spec,
    status,
    isJob,
    isCronJob,
    isDeployment,
    isStatefulSet,
    isDaemonSet,
    isReplicaSet,
    isRollbackKind,
    labels,
    annotations,
    createdAt,
    selector,
    selectorExpressions,
    containers,
    tolerations,
    nodeSelector,
    serviceAccountName,
    priorityClassName,
    podSecurityContext,
    affinity,
    topologySpreadConstraints,
    replicaView,
    daemonSetStatus,
    strategyType,
    strategyRolling,
    conditions,
    volumeClaimTemplates,
    promWorkloadMetrics,
    getWorkloadMetric,
    showStrategy,
    showDeploymentSettings,
    showStatefulSetSettings,
    showDaemonSetSettings,
    showReplicaSetSettings,
    showWorkloadSettings,
  } = data

  // the namespace counts too: the server keeps some to fewer people than the permission alone says
  const mayRollback = useCanI('resource.workload.rollback', 'patch', isRollbackKind ? deleteTarget(kind, namespace, name) : undefined)
  const canSuspend = useCanI('resource.cronjob.suspend', 'patch', isCronJob ? { group: 'batch', resource: 'cronjobs', namespace, name } : undefined)
  const canTrigger = useCanI('resource.cronjob.trigger', 'create', isCronJob ? { group: 'batch', resource: 'jobs', namespace } : undefined)

  if (isLoading && needsDescribe) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <div className="space-y-4">
      <WorkloadReplicasSection
        isJob={isJob}
        isCronJob={isCronJob}
        isDaemonSet={isDaemonSet}
        isReplicaSet={isReplicaSet}
        replicaView={replicaView}
        daemonSetStatus={daemonSetStatus}
        promWorkloadMetrics={promWorkloadMetrics}
        getWorkloadMetric={getWorkloadMetric}
      />

      <InfoSection title="Basic Info" actions={isRollbackKind && mayRollback && !writesBlocked ? (
        <button
          onClick={() => { rollbackMut.reset(); setRollbackDialogOpen(true) }}
          className="text-xs px-2 py-1 rounded-sm border border-slate-700 bg-slate-800 text-ink hover:border-slate-500"
        >
          {tr('rollback.title', 'Rollback')}
        </button>
      ) : undefined}>
        <div className="space-y-2">
          <InfoRow label="Kind" value={kind} />
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
          {describe?.generation != null && <InfoRow label="Generation" value={String(describe.generation)} />}
          {describe?.observed_generation != null && <InfoRow label="Observed Generation" value={String(describe.observed_generation)} />}
        </div>
      </InfoSection>

      <WorkloadStrategySection
        namespace={namespace}
        describe={describe}
        spec={spec}
        showStrategy={showStrategy}
        strategyType={strategyType}
        strategyRolling={strategyRolling}
        showWorkloadSettings={showWorkloadSettings}
        showDeploymentSettings={!!showDeploymentSettings}
        showStatefulSetSettings={!!showStatefulSetSettings}
        showDaemonSetSettings={!!showDaemonSetSettings}
        showReplicaSetSettings={!!showReplicaSetSettings}
        daemonSetStatus={daemonSetStatus}
      />

      {needsDescribe && <DescribeFailure error={describeError} showingRow />}

      <WorkloadKindInfo
        isJob={isJob}
        isCronJob={isCronJob}
        describe={describe}
        spec={spec}
        status={status}
        canSuspend={canSuspend}
        canTrigger={canTrigger}
        suspendMut={suspendMut}
        setTriggerDialogOpen={setTriggerDialogOpen}
        ownedJobs={ownedJobs}
      />

      <WorkloadOwnedResources
        namespace={namespace}
        owned={owned}
        isCronJob={isCronJob}
        isDaemonSet={isDaemonSet}
        isDeployment={isDeployment}
        isJob={isJob}
        isReplicaSet={isReplicaSet}
        isStatefulSet={isStatefulSet}
        describe={describe}
        ownedJobs={ownedJobs}
      />

      {Object.keys(selector).length > 0 && (
        <InfoSection title="Selector">
          <KeyValueTags data={selector} />
        </InfoSection>
      )}

      {selectorExpressions.length > 0 && (
        <InfoSection title="Selector Expressions">
          <div className="space-y-1 text-xs text-slate-200">
            {selectorExpressions.map((expr: any, idx: number) => (
              <div key={`${expr.key || 'expr'}-${idx}`}>
                {expr.key || '-'} {expr.operator || '-'} {Array.isArray(expr.values) && expr.values.length > 0 ? expr.values.join(', ') : ''}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {(serviceAccountName || priorityClassName) && (
        <InfoSection title="Pod Template">
          <div className="space-y-2">
            {serviceAccountName && <InfoRow label="Service Account" value={<ResourceLink kind="ServiceAccount" name={serviceAccountName} namespace={namespace} />} />}
            {priorityClassName && <InfoRow label="Priority Class" value={priorityClassName} />}
          </div>
        </InfoSection>
      )}

      {Object.keys(nodeSelector).length > 0 && (
        <InfoSection title="Node Selector">
          <KeyValueTags data={nodeSelector} />
        </InfoSection>
      )}

      <WorkloadContainers containers={containers} />

      {/* STS volumeClaimTemplates: verified — shows name / storage class / access modes / size */}
      {isStatefulSet && volumeClaimTemplates.length > 0 && (
        <InfoSection title="Volume Claim Templates">
          <div className="space-y-2 text-xs text-slate-200">
            {volumeClaimTemplates.map((vct: any, idx: number) => (
              <div key={`${vct.name || 'vct'}-${idx}`} className="rounded-sm border border-slate-800 p-2 space-y-1">
                <div className="font-medium text-ink">{vct.name || '-'}</div>
                <div>StorageClass: {vct.storage_class_name || vct.spec?.storageClassName || '-'}</div>
                <div>
                  Access Modes: {(() => {
                    const modes = vct.access_modes || vct.spec?.accessModes
                    return Array.isArray(modes) ? modes.join(', ') : '-'
                  })()}
                </div>
                <div>
                  Requests: {(() => {
                    const requests = (vct.requests as Record<string, string> | undefined)
                      ?? ((vct.spec?.resources?.requests as Record<string, string> | undefined) || {})
                    const entries = Object.entries(requests)
                    return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join(', ') : '-'
                  })()}
                </div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {tolerations.length > 0 && (
        <InfoSection title="Tolerations">
          <div className="space-y-1 text-xs text-slate-200">
            {tolerations.map((tol: any, idx: number) => (
              <div key={`${tol.key || 'tol'}-${idx}`}>{formatToleration(tol)}</div>
            ))}
          </div>
        </InfoSection>
      )}

      {podSecurityContext && Object.keys(podSecurityContext).length > 0 && (
        <InfoSection title="Pod Security Context">
          <div className="space-y-2">
            {podSecurityContext.runAsUser != null && <InfoRow label="Run As User" value={String(podSecurityContext.runAsUser)} />}
            {podSecurityContext.runAsGroup != null && <InfoRow label="Run As Group" value={String(podSecurityContext.runAsGroup)} />}
            {podSecurityContext.fsGroup != null && <InfoRow label="FS Group" value={String(podSecurityContext.fsGroup)} />}
            {podSecurityContext.runAsNonRoot != null && <InfoRow label="Run As Non-Root" value={boolText(podSecurityContext.runAsNonRoot)} />}
            {podSecurityContext.fsGroupChangePolicy != null && <InfoRow label="FS Group Change Policy" value={String(podSecurityContext.fsGroupChangePolicy)} />}
            {podSecurityContext.seccompProfile?.type != null && <InfoRow label="Seccomp Profile" value={String(podSecurityContext.seccompProfile.type)} />}
            {Array.isArray(podSecurityContext.supplementalGroups) && podSecurityContext.supplementalGroups.length > 0 && (
              <InfoRow label="Supplemental Groups" value={podSecurityContext.supplementalGroups.join(', ')} />
            )}
          </div>
        </InfoSection>
      )}

      <WorkloadAffinity affinity={affinity} topologySpreadConstraints={topologySpreadConstraints} />

      {conditions.length > 0 && (
        <InfoSection title="Conditions">
          <ConditionsTable conditions={conditions} />
        </InfoSection>
      )}

      <PolicyViolations kind={kind} namespace={namespace ?? ''} name={name} apiVersion={violationsApiVersion(kind)} />
      {NETPOL_KINDS.has(kind) && <NetworkPolicies kind={kind} namespace={namespace ?? ''} name={name} />}
      {NETPOL_KINDS.has(kind) && <NetworkFlows kind={kind} namespace={namespace ?? ''} name={name} />}
      {NETPOL_KINDS.has(kind) && <NetworkDrops kind={kind} namespace={namespace ?? ''} name={name} />}
      {NETPOL_KINDS.has(kind) && <TopTalkers kind={kind} namespace={namespace ?? ''} name={name} />}

      {logSearchAvailable && namespace && LOG_SEARCH_KINDS.includes(kind) && (
        <InfoSection
          title="Log search"
          actions={
            <button
              type="button"
              data-testid="workload-logsearch-toggle"
              aria-expanded={logSearchOpen}
              onClick={() => setLogSearchOpen((o) => !o)}
              className="text-xs text-primary-400 hover:text-primary-300 whitespace-nowrap"
            >
              {logSearchOpen ? tr('clusterView.logSearch.hide', 'Hide') : tr('clusterView.logSearch.open', 'Search logs')}
            </button>
          }
        >
          {logSearchOpen ? (
            <LogSearchView size="sm" namespace={namespace} workload={{ kind, name }} />
          ) : (
            <p className="text-xs text-slate-500">
              {tr('clusterView.logSearch.workloadHint', "Search this {{kind}}'s pods in the log store, including pods that are gone.", { kind })}
            </p>
          )}
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && (
        <InfoSection title="Labels">
          <KeyValueTags data={labels} />
        </InfoSection>
      )}
      {Object.keys(annotations).length > 0 && (
        <InfoSection title="Annotations">
          <KeyValueTags data={annotations} />
        </InfoSection>
      )}

      <EventsSection events={describe?.events} error={describe?.events_error} loading={isLoading} />

      <WorkloadDialogs
        target={`${kind} ${namespace}/${name}`}
        triggerToast={triggerToast}
        dismissToast={() => setTriggerToast(null)}
        triggerDialogOpen={triggerDialogOpen}
        setTriggerDialogOpen={setTriggerDialogOpen}
        triggerMut={triggerMut}
        rollbackDialogOpen={rollbackDialogOpen}
        setRollbackDialogOpen={setRollbackDialogOpen}
        rollbackMut={rollbackMut}
        revisions={revisions}
        selectedRevision={selectedRevision}
        setSelectedRevision={setSelectedRevision}
      />
    </div>
  )
}
