import { useTranslation } from 'react-i18next'
import {
  InfoSection,
  InfoRow,
  KeyValueTags,
  ConditionsTable,
  EventsTable,
  fmtRel,
  fmtTs,
} from './DetailCommon'
import { ResourceLink } from './ResourceLink'
import { boolText, formatToleration } from './workload-info/workloadInfoFormatters'
import { useWorkloadData } from './workload-info/useWorkloadData'
import WorkloadReplicasSection from './workload-info/WorkloadReplicasSection'
import WorkloadStrategySection from './workload-info/WorkloadStrategySection'
import WorkloadKindInfo from './workload-info/WorkloadKindInfo'
import WorkloadOwnedResources from './workload-info/WorkloadOwnedResources'
import WorkloadContainers from './workload-info/WorkloadContainers'
import WorkloadAffinity from './workload-info/WorkloadAffinity'
import WorkloadDialogs from './workload-info/WorkloadDialogs'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

export default function WorkloadInfo({ name, namespace, kind, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, o?: Record<string, any>) => t(key, { defaultValue: fallback, ...o })

  const data = useWorkloadData({ name, namespace, kind, rawJson })

  const {
    describe,
    isLoading,
    isError,
    needsDescribe,
    ownedJobs,
    revisions,
    suspendMut,
    triggerMut,
    rollbackMut,
    has,
    triggerDialogOpen,
    setTriggerDialogOpen,
    triggerToast,
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
    events,
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

  if (isLoading && needsDescribe) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <div className="space-y-4">
      <WorkloadReplicasSection
        isJob={isJob}
        isCronJob={isCronJob}
        isDaemonSet={isDaemonSet}
        replicaView={replicaView}
        daemonSetStatus={daemonSetStatus}
        promWorkloadMetrics={promWorkloadMetrics}
        getWorkloadMetric={getWorkloadMetric}
      />

      <InfoSection title="Basic Info" actions={isRollbackKind && has('resource.workload.rollback') ? (
        <button
          onClick={() => setRollbackDialogOpen(true)}
          className="text-xs px-2 py-1 rounded border border-slate-700 bg-slate-800 text-white hover:border-slate-500"
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

      {needsDescribe && isError && (
        <p className="text-xs text-amber-300">
          {tr('common.describeUnavailable', 'Some detailed fields are unavailable right now.')}
        </p>
      )}

      <WorkloadKindInfo
        isJob={isJob}
        isCronJob={isCronJob}
        describe={describe}
        spec={spec}
        status={status}
        has={has}
        suspendMut={suspendMut}
        setTriggerDialogOpen={setTriggerDialogOpen}
        ownedJobs={ownedJobs}
      />

      <WorkloadOwnedResources
        kind={kind}
        name={name}
        namespace={namespace}
        selector={selector}
        isCronJob={isCronJob}
        isDaemonSet={isDaemonSet}
        isDeployment={isDeployment}
        isJob={isJob}
        isReplicaSet={isReplicaSet}
        isStatefulSet={isStatefulSet}
        describe={describe}
        ownedJobs={ownedJobs}
        volumeClaimTemplates={volumeClaimTemplates}
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

      {isStatefulSet && volumeClaimTemplates.length > 0 && (
        <InfoSection title="Volume Claim Templates">
          <div className="space-y-2 text-xs text-slate-200">
            {volumeClaimTemplates.map((vct: any, idx: number) => (
              <div key={`${vct.name || 'vct'}-${idx}`} className="rounded border border-slate-800 p-2 space-y-1">
                <div className="font-medium text-white">{vct.name || '-'}</div>
                <div>StorageClass: {vct.storage_class_name || vct.spec?.storageClassName || '-'}</div>
                <div>
                  Access Modes: {Array.isArray(vct.access_modes || vct.spec?.accessModes)
                    ? (vct.access_modes || vct.spec?.accessModes).join(', ')
                    : '-'}
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

      {events.length > 0 && (
        <InfoSection title="Events">
          <EventsTable events={events} />
        </InfoSection>
      )}

      <WorkloadDialogs
        triggerToast={triggerToast}
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
