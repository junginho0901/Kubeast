import { useTranslation } from 'react-i18next'
import { Pause, Play, Zap } from 'lucide-react'
import { InfoSection, InfoRow, Th, Tx } from '../DetailCommon'
import { fmtRel, fmtTs } from '../detailFormat'
import { nextRunOf, nextRunTitle } from '@/pages/workloads/cronjobs/cronJobHelpers'
import { humanDuration } from '@/utils/time'
import { formatDuration, jobDrawerInfo, jobDurationSeconds } from '@/pages/workloads/jobs/jobHelpers'

interface Props {
  isJob: boolean
  isCronJob: boolean
  describe: any
  spec: Record<string, unknown>
  status: Record<string, unknown>
  canSuspend: boolean
  canTrigger: boolean
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
  canSuspend,
  canTrigger,
  suspendMut,
  setTriggerDialogOpen,
  ownedJobs,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, o?: Record<string, any>) => t(key, { defaultValue: fallback, ...o })

  if (!isJob && !isCronJob) return null

  const job = isJob ? jobDrawerInfo(describe, spec, status) : null

  return (
    <>
      {job && (
        <InfoSection title="Job Info">
          <div className="space-y-2">
            <InfoRow label="Completions" value={job.completions} />
            <InfoRow label="Parallelism" value={job.parallelism} />
            <InfoRow label="Active" value={job.active} />
            <InfoRow label="Succeeded" value={job.succeeded} />
            <InfoRow label="Failed" value={job.failed} />
            {job.status && <InfoRow label="Status" value={job.status} />}
            {job.start_time && <InfoRow label="Start Time" value={`${fmtTs(job.start_time)} (${fmtRel(job.start_time)})`} />}
            {job.completion_time && <InfoRow label="Completion Time" value={`${fmtTs(job.completion_time)} (${fmtRel(job.completion_time)})`} />}
            {job.duration && <InfoRow label="Duration" value={job.duration} />}
            {job.backoff_limit && <InfoRow label="Backoff Limit" value={job.backoff_limit} />}
            {job.active_deadline && <InfoRow label="Active Deadline" value={job.active_deadline} />}
            {job.ttl_after_finished && <InfoRow label="TTL After Finished" value={job.ttl_after_finished} />}
            {job.completion_mode && <InfoRow label="Completion Mode" value={job.completion_mode} />}
            {job.suspend && <InfoRow label="Suspend" value={job.suspend} />}
            {job.manual_selector && <InfoRow label="Manual Selector" value={job.manual_selector} />}
          </div>
        </InfoSection>
      )}

      {isCronJob && (
        <InfoSection
          title="CronJob Info"
          actions={(canSuspend || canTrigger) ? (
            <div className="flex gap-2">
              {canSuspend && (
                <button
                  onClick={() => suspendMut.mutate(!(describe?.suspend ?? spec.suspend))}
                  disabled={suspendMut.isPending}
                  className="text-xs px-2 py-1 rounded-sm border border-slate-700 bg-slate-800 text-ink hover:border-slate-500 flex items-center gap-1 disabled:opacity-50"
                >
                  {(describe?.suspend ?? spec.suspend) ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                  {(describe?.suspend ?? spec.suspend) ? tr('cronjob.resume', 'Resume') : tr('cronjob.suspend', 'Suspend')}
                </button>
              )}
              {canTrigger && (
                <button
                  onClick={() => setTriggerDialogOpen(true)}
                  className="text-xs px-2 py-1 rounded-sm border border-slate-700 bg-slate-800 text-ink hover:border-slate-500 flex items-center gap-1"
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
            <InfoRow
              label="Time Zone"
              value={describe?.time_zone ? String(describe.time_zone) : tr('cronjobs.controllerZone', "the controller's time zone (not set; computed in this browser's zone)")}
            />
            <InfoRow
              label="Next Run"
              value={(() => {
                const cronjob = {
                  schedule: String(describe?.schedule ?? spec.schedule ?? ''),
                  suspend: Boolean(describe?.suspend ?? spec.suspend),
                  time_zone: describe?.time_zone ? String(describe.time_zone) : null,
                  last_schedule_time: (describe?.last_schedule_time ?? status.lastScheduleTime ?? null) as string | null,
                  created_at: describe?.created_at ? String(describe.created_at) : null,
                }
                const next = nextRunOf(cronjob)
                return next ? <span title={nextRunTitle(cronjob, tr)}>{`${fmtTs(next.toISOString())} (${humanDuration((next.getTime() - Date.now()) / 1000)})`}</span> : '-'
              })()}
            />
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
                <p className="text-xs font-medium text-slate-300 mb-1"><Tx text="Recent Runs (last {{n}})" values={{ n: sorted.length }} /></p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-slate-400">
                      <tr>
                        <Th className="text-left py-1">Job</Th>
                        <Th className="text-left py-1">Status</Th>
                        <Th className="text-left py-1">Started</Th>
                        <Th className="text-left py-1">Duration</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {sorted.map((j: any) => (
                        <tr key={j.name} className="text-slate-200">
                          <td className="py-1 pr-2 font-mono">{j.name}</td>
                          <td className="py-1 pr-2">{j.status || '-'}</td>
                          <td className="py-1 pr-2 text-slate-400">{fmtRel(j.start_time)}</td>
                          <td className="py-1 pr-2">{formatDuration(jobDurationSeconds(j))}</td>
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
