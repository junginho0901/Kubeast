import { useTranslation } from 'react-i18next'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { formatDuration, jobDurationSeconds } from '@/pages/workloads/jobs/jobHelpers'
import { workloadStatusLabel } from '@/utils/workloadStatus'
import { InfoSection, StatusBadge, Th, Tx } from '../DetailCommon'
import { fmtRel } from '../detailFormat'
import { usePagination } from '../usePagination'
import { ResourceLink } from '../ResourceLink'
import type { OwnedResources } from './useOwnedWatchedResources'
import { ownedDisplayJobs } from './workloadLayer'
import { ownedDisplayPods } from './workloadPodsLayer'

interface Props {
  namespace?: string
  owned: OwnedResources
  isCronJob: boolean
  isDaemonSet: boolean
  isDeployment: boolean
  isJob: boolean
  isReplicaSet: boolean
  isStatefulSet: boolean
  describe: any
  ownedJobs: any
}

export default function WorkloadOwnedResources({
  namespace,
  owned,
  isCronJob,
  isDaemonSet,
  isDeployment,
  isJob,
  isReplicaSet,
  isStatefulSet,
  describe,
  ownedJobs,
}: Props) {
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()
  const tr = (key: string, fallback: string, o?: Record<string, any>) => t(key, { defaultValue: fallback, ...o })

  const { replicaSets, jobs: liveJobs, pvcsByPodName, rsEnabled, jobsEnabled, pvcsEnabled, podTable } = owned

  // The table's rows (whole and live, or the server's pages); describe.owned_pods until the first of them came.
  const tableRows = owned.podsEnabled && (podTable.whole !== undefined || podTable.page !== undefined)
  const describePods = tableRows ? [] : ownedDisplayPods(describe, { pods: [], podsEnabled: false })
  const { items: pagedDescribePods, nav: describePodsNav } = usePagination(describePods as Array<any>, 10)
  const podRows: Array<any> = tableRows ? podTable.items : pagedDescribePods
  const podTotal = tableRows ? podTable.total : describePods.length
  const podsWaiting = !tableRows && describePods.length === 0 && podTable.loading
  const showOwnedPods = (isDaemonSet || isReplicaSet || isStatefulSet || isJob) && (podTotal > 0 || podsWaiting)
  const showDeploymentRS = isDeployment && rsEnabled
  // CronJob owned Jobs — prefer live hook result, fallback to prop (parent's
  // staleTime-only query) until first watch tick.
  const displayJobs = ownedDisplayJobs({ jobs: liveJobs, jobsEnabled }, ownedJobs)
  const showOwnedJobs = isCronJob && displayJobs.length > 0

  // Pre-sort/pre-slice computed lists for pagination. Keeps existing display
  // semantics (RS sorted newest first; Owned Pods table).
  const sortedRs = [...(Array.isArray(replicaSets) ? replicaSets : [])]
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  const { items: pagedRs, nav: rsNav } = usePagination(sortedRs, 10)
  const { items: pagedOwnedJobs, nav: ownedJobsNav } = usePagination(displayJobs, 10)

  return (
    <>
      {showDeploymentRS && (
        <InfoSection title="Owned ReplicaSets ({{n}})" titleValues={{ n: replicaSets.length }}>
          {replicaSets.length === 0 ? (
            <p className="text-xs text-slate-400"><Tx>No replica sets owned by this deployment yet.</Tx></p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs table-fixed min-w-[600px]">
                <thead className="text-slate-400">
                  <tr>
                    <Th className="text-left py-2 w-[35%]">Name</Th>
                    <Th className="text-left py-2 w-[12%]">Replicas</Th>
                    <Th className="text-left py-2 w-[12%]">Ready</Th>
                    <Th className="text-left py-2 w-[12%]">Available</Th>
                    <Th className="text-left py-2 w-[15%]">Status</Th>
                    <Th className="text-left py-2 w-[14%]">Age</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {pagedRs.map((rs) => (
                    <tr key={`${rs.namespace}/${rs.name}`} className="text-slate-200">
                      <td className="py-2 pr-2"><ResourceLink kind="ReplicaSet" name={rs.name} namespace={rs.namespace} /></td>
                      <td className="py-2 pr-2 font-mono">{rs.replicas}</td>
                      <td className="py-2 pr-2 font-mono">{rs.ready_replicas}</td>
                      <td className="py-2 pr-2 font-mono">{rs.available_replicas}</td>
                      <td className="py-2 pr-2"><StatusBadge status={rs.status || '-'} label={workloadStatusLabel(tr, rs.status)} /></td>
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
        <InfoSection title="Pods ({{n}})" titleValues={{ n: podTotal }}>
          {tableRows && podTable.note}
          {podsWaiting ? (
            <p className="text-xs text-slate-400"><Tx>Loading...</Tx></p>
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[640px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[27%]">{tr('pods.table.name', 'Name')}</th>
                  <th className="text-left py-2 w-[13%]">{tr('pods.table.status', 'Status')}</th>
                  <th className="text-left py-2 w-[7%]">{tr('pods.table.ready', 'Ready')}</th>
                  <th className="text-left py-2 w-[9%]">{tr('pods.table.restarts', 'Restarts')}</th>
                  <th className="text-left py-2 w-[24%]">{tr('pods.table.node', 'Node')}</th>
                  {pvcsEnabled && <Th className="text-left py-2 w-[20%]">PVC Status</Th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {podRows.map((pod: any) => {
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
                      <td className="py-2 pr-2 font-mono truncate" title={pod.node_name || undefined}>{pod.node_name || '-'}</td>
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
            {tableRows ? podTable.nav : describePodsNav}
          </div>
          )}
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
                    <td className="py-2 pr-2">{formatDuration(jobDurationSeconds(job))}</td>
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
