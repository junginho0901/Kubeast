import { useTranslation } from 'react-i18next'
import { Pause, Play, Zap } from 'lucide-react'
import { InfoSection, InfoRow, fmtRel, fmtTs } from '../DetailCommon'

interface Props {
  isJob: boolean
  isCronJob: boolean
  describe: any
  spec: Record<string, unknown>
  status: Record<string, unknown>
  has: (permission: string) => boolean
  suspendMut: { isPending: boolean; mutate: (suspend: boolean) => void }
  setTriggerDialogOpen: (open: boolean) => void
  ownedJobs?: Array<any>
}

export default function WorkloadKindInfo({
  isJob,
  isCronJob,
  describe,
  spec,
  status,
  has,
  suspendMut,
  setTriggerDialogOpen,
  ownedJobs,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, o?: Record<string, any>) => t(key, { defaultValue: fallback, ...o })

  if (!isJob && !isCronJob) return null

  return (
    <>
      {isJob && (
        <InfoSection title="Job Info">
          <div className="space-y-2">
            <InfoRow label="Completions" value={String(describe?.completions ?? spec.completions ?? '-')} />
            <InfoRow label="Parallelism" value={String(describe?.parallelism ?? spec.parallelism ?? '-')} />
            <InfoRow label="Active" value={String(describe?.active ?? status.active ?? 0)} />
            <InfoRow label="Succeeded" value={String(describe?.succeeded ?? status.succeeded ?? 0)} />
            <InfoRow label="Failed" value={String(describe?.failed ?? status.failed ?? 0)} />
            {describe?.status && <InfoRow label="Status" value={String(describe.status)} />}
            {describe?.start_time && <InfoRow label="Start Time" value={`${fmtTs(String(describe.start_time))} (${fmtRel(String(describe.start_time))})`} />}
            {describe?.completion_time && <InfoRow label="Completion Time" value={`${fmtTs(String(describe.completion_time))} (${fmtRel(String(describe.completion_time))})`} />}
            {describe?.duration_seconds != null && <InfoRow label="Duration" value={`${String(describe.duration_seconds)}s`} />}
            {describe?.backoff_limit != null && <InfoRow label="Backoff Limit" value={String(describe.backoff_limit)} />}
            {describe?.active_deadline_seconds != null && <InfoRow label="Active Deadline" value={`${String(describe.active_deadline_seconds)}s`} />}
            {describe?.ttl_seconds_after_finished != null && <InfoRow label="TTL After Finished" value={`${String(describe.ttl_seconds_after_finished)}s`} />}
            {describe?.completion_mode && <InfoRow label="Completion Mode" value={String(describe.completion_mode)} />}
            {describe?.suspend != null && <InfoRow label="Suspend" value={describe.suspend ? 'Yes' : 'No'} />}
            {describe?.manual_selector != null && <InfoRow label="Manual Selector" value={describe.manual_selector ? 'Yes' : 'No'} />}
          </div>
        </InfoSection>
      )}

      {isCronJob && (
        <InfoSection
          title="CronJob Info"
          actions={(has('resource.cronjob.suspend') || has('resource.cronjob.trigger')) ? (
            <div className="flex gap-2">
              {has('resource.cronjob.suspend') && (
                <button
                  onClick={() => suspendMut.mutate(!(describe?.suspend ?? spec.suspend))}
                  disabled={suspendMut.isPending}
                  className="text-xs px-2 py-1 rounded border border-slate-700 bg-slate-800 text-white hover:border-slate-500 flex items-center gap-1 disabled:opacity-50"
                >
                  {(describe?.suspend ?? spec.suspend) ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                  {(describe?.suspend ?? spec.suspend) ? tr('cronjob.resume', 'Resume') : tr('cronjob.suspend', 'Suspend')}
                </button>
              )}
              {has('resource.cronjob.trigger') && (
                <button
                  onClick={() => setTriggerDialogOpen(true)}
                  className="text-xs px-2 py-1 rounded border border-slate-700 bg-slate-800 text-white hover:border-slate-500 flex items-center gap-1"
                >
                  <Zap className="w-3 h-3" />
                  {tr('cronjob.runNow', 'Run Now')}
                </button>
              )}
            </div>
          ) : undefined}
        >
          <div className="space-y-2">
            <InfoRow label="Schedule" value={String(describe?.schedule ?? spec.schedule ?? '-')} />
            <InfoRow label="Suspend" value={(describe?.suspend ?? spec.suspend) ? 'Yes' : 'No'} />
            <InfoRow label="Concurrency Policy" value={String(describe?.concurrency_policy ?? spec.concurrencyPolicy ?? '-')} />
            {(describe?.starting_deadline_seconds ?? spec.startingDeadlineSeconds) != null && (
              <InfoRow
                label="Starting Deadline"
                value={`${String(describe?.starting_deadline_seconds ?? spec.startingDeadlineSeconds)}s`}
              />
            )}
            {describe?.successful_jobs_history_limit != null && (
              <InfoRow label="Successful Jobs History" value={String(describe.successful_jobs_history_limit)} />
            )}
            {describe?.failed_jobs_history_limit != null && (
              <InfoRow label="Failed Jobs History" value={String(describe.failed_jobs_history_limit)} />
            )}
            {describe?.time_zone && <InfoRow label="Time Zone" value={String(describe.time_zone)} />}
            <InfoRow label="Active Jobs" value={String(describe?.active ?? (Array.isArray(status.active) ? status.active.length : 0))} />
            {(describe?.last_schedule_time ?? status.lastScheduleTime) != null && (
              <InfoRow label="Last Schedule" value={fmtTs(String(describe?.last_schedule_time ?? status.lastScheduleTime))} />
            )}
            {(describe?.last_successful_time ?? status.lastSuccessfulTime) != null && (
              <InfoRow label="Last Successful" value={fmtTs(String(describe?.last_successful_time ?? status.lastSuccessfulTime))} />
            )}
          </div>

          {Array.isArray(ownedJobs) && ownedJobs.length > 0 && (() => {
            const sorted = [...ownedJobs]
              .filter((j: any) => j?.start_time)
              .sort((a: any, b: any) => String(b.start_time).localeCompare(String(a.start_time)))
              .slice(0, 3)
            if (sorted.length === 0) return null
            return (
              <div className="mt-3">
                <p className="text-xs font-medium text-slate-300 mb-1">Recent Runs (last {sorted.length})</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="text-left py-1">Job</th>
                        <th className="text-left py-1">Status</th>
                        <th className="text-left py-1">Started</th>
                        <th className="text-left py-1">Duration</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {sorted.map((j: any) => (
                        <tr key={j.name} className="text-slate-200">
                          <td className="py-1 pr-2 font-mono">{j.name}</td>
                          <td className="py-1 pr-2">{j.status || '-'}</td>
                          <td className="py-1 pr-2 text-slate-400">{fmtRel(j.start_time)}</td>
                          <td className="py-1 pr-2">{j.duration_seconds != null ? `${j.duration_seconds}s` : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}
        </InfoSection>
      )}
    </>
  )
}
