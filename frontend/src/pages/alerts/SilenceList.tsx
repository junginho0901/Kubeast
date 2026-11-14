import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import { ActionFailure } from '@/components/ActionFailure'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { ListPager } from '@/components/ListPager'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { pageOf } from '@/utils/listPages'
import { api } from '@/services/api'
import { useConfirm } from '@/services/confirm'
import { useCluster } from '@/contexts/ClusterContext'
import { useAIContext } from '@/hooks/useAIContext'
import { formatTime, utcTitle } from '@/utils/time'

// The active and pending silences that mute this cluster's alerts in its alert store: its own, and the store's
// others (no cluster condition, or a cluster pattern this cluster meets) marked by their scope. Expiring one of its
// own (resource.alert.silence, with features.alertStore.silences) ends it now and is audited server-side
// (alert.silence.expire); the others are not this cluster's to end. The tab fits the screen as the inbox does: the
// rows that fit (or the footer's fixed choice) and the list footer, since a store keeps every silence of every team.
const COLUMNS = 5

export default function SilenceList({ canExpire }: { canExpire: boolean }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const { currentCluster } = useCluster()
  // per cluster: another cluster's list is never shown while this one loads
  const { data, isLoading, error } = useQuery({ queryKey: ['alert-inbox', 'silences', currentCluster], queryFn: api.listAlertSilences, retry: false })
  const expire = useMutation({
    mutationFn: (id: string) => api.expireAlertSilence(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alert-inbox'] }),
  })
  const silences = data ?? []
  const scopeOf = (s: { scope?: string }) => s.scope ?? 'cluster'
  const own = silences.filter((s) => scopeOf(s) === 'cluster').length
  const [page, setPage] = useState(1)
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: `${isLoading}:${silences.length}` })
  const shown = pageOf(silences, page, rowsPerPage)

  useAIContext(data ? {
    source: 'SilenceList',
    summary: `이 클러스터 알림에 걸린 무음 ${silences.length}건 (이 클러스터 것 ${own}, 다른 범위 ${silences.length - own})`,
    data: {
      silences: silences.map((s) => ({
        state: s.state, scope: scopeOf(s), matchers: s.matchers, created_by: s.createdBy || undefined, comment: s.comment || undefined,
        ends_at: s.endsAt,
      })),
    },
  } : null, [data])

  return (
    <div ref={containerRef} className="card flex-1 min-h-0 flex flex-col" data-testid="silence-list">
      <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
      <table className="w-full text-sm">
        <thead ref={theadRef} className="text-slate-400">
          <tr>
            <th className="text-left py-3 px-4 w-[100px]">{tr('alertInbox.col.status', 'Status')}</th>
            <th className="text-left py-3 px-4">{tr('alertInbox.silence.conditions', 'Label conditions')}</th>
            <th className="text-left py-3 px-4 w-[200px]">{tr('alertInbox.silence.by', 'By')}</th>
            <th className="text-left py-3 px-4 w-[170px]">{tr('alertInbox.silence.ends', 'Ends')}</th>
            <th className="py-3 px-4 w-[110px]" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700">
          {shown.rows.map((s, idx) => (
            <tr key={s.id} ref={idx === 0 ? firstRowRef : undefined} className="text-slate-200" data-testid={`silence-row-${s.id}`}>
              <td className="py-3 px-4 text-xs">
                {tr(`alertInbox.silence.state.${s.state}`, s.state)}
                {scopeOf(s) !== 'cluster' && (
                  <span className="block mt-1 text-slate-400" title={tr(`alertInbox.silence.scopeHint.${scopeOf(s)}`, scopeOf(s))} data-testid="silence-scope">
                    {tr(`alertInbox.silence.scope.${scopeOf(s)}`, scopeOf(s))}
                  </span>
                )}
              </td>
              <td className="py-3 px-4">
                <span className="flex flex-wrap gap-1">
                  {s.matchers.map((m) => <span key={m} className="rounded-sm border border-slate-600 px-1.5 py-0.5 font-mono text-xs text-slate-200">{m}</span>)}
                </span>
                {s.comment && <span className="mt-1 block text-xs text-slate-400">{s.comment}</span>}
              </td>
              <td className="py-3 px-4 text-xs break-all">{s.createdBy || '-'}</td>
              <td className="py-3 px-4 text-xs whitespace-nowrap" title={utcTitle(s.endsAt)}>{formatTime(s.endsAt)}</td>
              <td className="py-3 px-4 text-right">
                {canExpire && scopeOf(s) === 'cluster' && (
                  <button
                    type="button"
                    disabled={expire.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: tr('alertInbox.silence.expireTitle', 'End the silence'),
                        message: tr('alertInbox.silence.expireConfirm', 'End this silence now? Matching alerts are sent again.'),
                        confirmLabel: tr('alertInbox.silence.expire', 'End now'),
                        danger: true,
                      })
                      if (ok) expire.mutate(s.id)
                    }}
                    className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:border-slate-400 disabled:opacity-40"
                    data-testid="silence-expire"
                  >
                    {tr('alertInbox.silence.expire', 'End now')}
                  </button>
                )}
                {expire.variables === s.id && <ActionFailure error={expire.error} action="end" testId="silence-expire-error" className="mt-1 text-xs text-left" />}
              </td>
            </tr>
          ))}
          {isLoading && (
            <tr><td colSpan={COLUMNS} className="py-10 px-4 text-center text-slate-400"><Loader2 className="inline w-4 h-4 animate-spin" /></td></tr>
          )}
          {!isLoading && silences.length === 0 && (
            <tr><td colSpan={COLUMNS} className="py-6 px-4 text-center text-slate-400">
              {error ? tr('alertInbox.silence.listFailed', 'The alert store did not answer.') : tr('common.listEmpty', 'No items.')}
            </td></tr>
          )}
        </tbody>
        <AdaptiveTableFillerRows count={rowsPerPage - shown.rows.length} columnCount={COLUMNS} />
      </table>
      </div>
      <ListPager currentPage={shown.page} totalPages={shown.pages} total={silences.length} rowsPerPage={rowsPerPage} onPageChange={setPage} testId="silences-pager" />
    </div>
  )
}
