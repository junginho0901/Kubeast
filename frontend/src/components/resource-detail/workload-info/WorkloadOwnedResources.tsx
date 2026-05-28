import { useTranslation } from 'react-i18next'
import { InfoSection, StatusBadge, fmtRel } from '../DetailCommon'
import { ResourceLink } from '../ResourceLink'

interface Props {
  namespace?: string
  isCronJob: boolean
  isDaemonSet: boolean
  isReplicaSet: boolean
  isStatefulSet: boolean
  describe: any
  ownedJobs: any
}

export default function WorkloadOwnedResources({
  namespace,
  isCronJob,
  isDaemonSet,
  isReplicaSet,
  isStatefulSet,
  describe,
  ownedJobs,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, o?: Record<string, any>) => t(key, { defaultValue: fallback, ...o })

  const ownedPods = (describe as any)?.owned_pods
  const showOwnedPods = (isDaemonSet || isReplicaSet || isStatefulSet) && Array.isArray(ownedPods) && ownedPods.length > 0
  const showOwnedJobs = isCronJob && Array.isArray(ownedJobs) && ownedJobs.length > 0

  return (
    <>
      {showOwnedPods && (
        <InfoSection title={tr('workload.ownedPods', 'Pods')}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[600px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[35%]">{tr('pods.table.name', 'Name')}</th>
                  <th className="text-left py-2 w-[15%]">{tr('pods.table.status', 'Status')}</th>
                  <th className="text-left py-2 w-[10%]">{tr('pods.table.ready', 'Ready')}</th>
                  <th className="text-left py-2 w-[10%]">{tr('pods.table.restarts', 'Restarts')}</th>
                  <th className="text-left py-2 w-[30%]">{tr('pods.table.node', 'Node')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(ownedPods as Array<any>).slice(0, 50).map((pod: any) => (
                  <tr key={pod.name} className="text-slate-200">
                    <td className="py-2 pr-2"><ResourceLink kind="Pod" name={pod.name} namespace={pod.namespace || namespace} /></td>
                    <td className="py-2 pr-2"><StatusBadge status={pod.status || '-'} /></td>
                    <td className="py-2 pr-2 font-mono">{pod.ready || '-'}</td>
                    <td className="py-2 pr-2 font-mono">{pod.restart_count ?? 0}</td>
                    <td className="py-2 pr-2 font-mono truncate">{pod.node_name || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                {ownedJobs.slice(0, 20).map((job: any) => (
                  <tr key={job.name} className="text-slate-200">
                    <td className="py-2 pr-2"><ResourceLink kind="Job" name={job.name} namespace={job.namespace || namespace} /></td>
                    <td className="py-2 pr-2"><StatusBadge status={job.status || '-'} /></td>
                    <td className="py-2 pr-2">{job.start_time ? fmtRel(job.start_time) : '-'}</td>
                    <td className="py-2 pr-2">{job.duration_seconds != null ? `${job.duration_seconds}s` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}
    </>
  )
}
