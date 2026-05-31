import { useTranslation } from 'react-i18next'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { InfoSection, StatusBadge, fmtRel, usePagination } from '../DetailCommon'
import { ResourceLink } from '../ResourceLink'
import { useOwnedWatchedResources } from './useOwnedWatchedResources'

interface Props {
  kind: string
  name: string
  namespace?: string
  selector: Record<string, string>
  isCronJob: boolean
  isDaemonSet: boolean
  isDeployment: boolean
  isJob: boolean
  isReplicaSet: boolean
  isStatefulSet: boolean
  describe: any
  ownedJobs: any
  volumeClaimTemplates?: Array<any>
}

export default function WorkloadOwnedResources({
  kind,
  name,
  namespace,
  selector,
  isCronJob,
  isDaemonSet,
  isDeployment,
  isJob,
  isReplicaSet,
  isStatefulSet,
  describe,
  ownedJobs,
  volumeClaimTemplates,
}: Props) {
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()
  const tr = (key: string, fallback: string, o?: Record<string, any>) => t(key, { defaultValue: fallback, ...o })

  const { pods, replicaSets, jobs: liveJobs, pvcsByPodName, podsEnabled, rsEnabled, jobsEnabled, pvcsEnabled } = useOwnedWatchedResources({
    kind,
    namespace,
    name,
    selector,
    volumeClaimTemplates,
  })

  // Fallback to describe.owned_pods for DS/RS/STS until the first watch tick.
  // The watch query returns the canonical list once enabled.
  const fallbackPods = (describe as any)?.owned_pods
  const displayPods = podsEnabled && pods.length > 0 ? pods : (Array.isArray(fallbackPods) ? fallbackPods : [])
  const showOwnedPods = (isDaemonSet || isReplicaSet || isStatefulSet || isJob) && displayPods.length > 0
  const showDeploymentRS = isDeployment && rsEnabled
  // CronJob owned Jobs — prefer live hook result, fallback to prop (parent's
  // staleTime-only query) until first watch tick.
  const displayJobs = jobsEnabled && liveJobs.length > 0
    ? liveJobs
    : (Array.isArray(ownedJobs) ? ownedJobs : [])
  const showOwnedJobs = isCronJob && displayJobs.length > 0

  // Pre-sort/pre-slice computed lists for pagination. Keeps existing display
  // semantics (RS sorted newest first; Owned Pods table).
  const sortedRs = [...(Array.isArray(replicaSets) ? replicaSets : [])]
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  const { items: pagedRs, nav: rsNav } = usePagination(sortedRs, 10)
  const { items: pagedDisplayPods, nav: displayPodsNav } = usePagination(displayPods as Array<any>, 10)
  const { items: pagedOwnedJobs, nav: ownedJobsNav } = usePagination(displayJobs, 10)

  return (
    <>
      {showDeploymentRS && (
        <InfoSection title={`Owned ReplicaSets (${replicaSets.length})`}>
          {replicaSets.length === 0 ? (
            <p className="text-xs text-slate-400">No replica sets owned by this deployment yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs table-fixed min-w-[600px]">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left py-2 w-[35%]">Name</th>
                    <th className="text-left py-2 w-[12%]">Replicas</th>
                    <th className="text-left py-2 w-[12%]">Ready</th>
                    <th className="text-left py-2 w-[12%]">Available</th>
                    <th className="text-left py-2 w-[15%]">Status</th>
                    <th className="text-left py-2 w-[14%]">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {pagedRs.map((rs) => (
                    <tr key={`${rs.namespace}/${rs.name}`} className="text-slate-200">
                      <td className="py-2 pr-2"><ResourceLink kind="ReplicaSet" name={rs.name} namespace={rs.namespace} /></td>
                      <td className="py-2 pr-2 font-mono">{rs.replicas}</td>
                      <td className="py-2 pr-2 font-mono">{rs.ready_replicas}</td>
                      <td className="py-2 pr-2 font-mono">{rs.available_replicas}</td>
                      <td className="py-2 pr-2"><StatusBadge status={rs.status || '-'} /></td>
                      <td className="py-2 pr-2 text-slate-400">{fmtRel(rs.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rsNav}
            </div>
          )}
        </InfoSection>
      )}

      {showOwnedPods && (
        <InfoSection title={tr('workload.ownedPods', `Pods (${displayPods.length})`)}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[700px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[28%]">{tr('pods.table.name', 'Name')}</th>
                  <th className="text-left py-2 w-[13%]">{tr('pods.table.status', 'Status')}</th>
                  <th className="text-left py-2 w-[8%]">{tr('pods.table.ready', 'Ready')}</th>
                  <th className="text-left py-2 w-[9%]">{tr('pods.table.restarts', 'Restarts')}</th>
                  <th className="text-left py-2 w-[22%]">{tr('pods.table.node', 'Node')}</th>
                  {pvcsEnabled && <th className="text-left py-2 w-[20%]">PVC Status</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedDisplayPods.map((pod: any) => {
                  const pvcEntries = pvcsEnabled ? (pvcsByPodName.get(pod.name) ?? []) : []
                  return (
                    <tr
                      key={`${pod.namespace || namespace}/${pod.name}`}
                      className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                      onClick={() => openDetail({ kind: 'Pod', name: pod.name, namespace: pod.namespace || namespace || '' })}
                    >
                      <td className="py-2 pr-2 font-mono">{pod.name}</td>
                      <td className="py-2 pr-2"><StatusBadge status={pod.status || pod.phase || '-'} /></td>
                      <td className="py-2 pr-2 font-mono">{pod.ready || '-'}</td>
                      <td className="py-2 pr-2 font-mono">{pod.restart_count ?? 0}</td>
                      <td className="py-2 pr-2 font-mono truncate">{pod.node_name || '-'}</td>
                      {pvcsEnabled && (
                        <td className="py-2 pr-2 text-[11px]">
                          {pvcEntries.length === 0 ? (
                            <span className="text-slate-500">-</span>
                          ) : (
                            <div className="flex flex-col gap-0.5">
                              {pvcEntries.map((entry) => (
                                <span key={entry.vct} className="font-mono truncate">
                                  <span className="text-slate-400">{entry.vct}:</span>{' '}
                                  <StatusBadge status={entry.pvc?.status || 'Missing'} />
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {displayPodsNav}
          </div>
        </InfoSection>
      )}

      {showOwnedJobs && (
        <InfoSection title={tr('cronjob.ownedJobs', 'Jobs')}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[500px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[35%]">{tr('cronjob.jobName', 'Name')}</th>
                  <th className="text-left py-2 w-[15%]">{tr('cronjob.jobStatus', 'Status')}</th>
                  <th className="text-left py-2 w-[25%]">{tr('cronjob.jobStarted', 'Started')}</th>
                  <th className="text-left py-2 w-[25%]">{tr('cronjob.jobDuration', 'Duration')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedOwnedJobs.map((job: any) => (
                  <tr key={job.name} className="text-slate-200">
                    <td className="py-2 pr-2"><ResourceLink kind="Job" name={job.name} namespace={job.namespace || namespace} /></td>
                    <td className="py-2 pr-2"><StatusBadge status={job.status || '-'} /></td>
                    <td className="py-2 pr-2">{job.start_time ? fmtRel(job.start_time) : '-'}</td>
                    <td className="py-2 pr-2">{job.duration_seconds != null ? `${job.duration_seconds}s` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ownedJobsNav}
          </div>
        </InfoSection>
      )}
    </>
  )
}
