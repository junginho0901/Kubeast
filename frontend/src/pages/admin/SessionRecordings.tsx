import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Film, Play, RefreshCw } from 'lucide-react'

import { api } from '@/services/api'
import type { SessionRecording } from '@/services/api/recordings'
import CustomDropdown from '@/components/CustomDropdown'
import { ListPager } from '@/components/ListPager'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import RecordingPlayerModal from '@/components/RecordingPlayerModal'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { formatWhen } from './accessRequestFormat'
import { utcTitle } from '@/utils/time'
import { RefreshFailure } from '@/components/RefreshFailure'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { failureOf } from '@/hooks/useRefresh'

// Admin → Session recordings: recorded pod exec / node shell terminals (the
// output the user saw). Opening one replays it; every read is audited.

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1 << 20)).toFixed(1)} MiB`
}

const COLUMNS = 8

// An interrupted recording keeps only what was uploaded before the server
// stopped; the rest was written to a spool file that is gone.
function keptBytes(r: SessionRecording): number {
  return r.status === 'interrupted' ? r.uploaded_bytes : r.bytes || r.uploaded_bytes
}

function targetText(r: SessionRecording): string {
  return `${r.namespace ? `${r.namespace}/` : ''}${r.target}${r.container ? ` (${r.container})` : ''}`
}

export default function SessionRecordings() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const [user, setUser] = useState('')
  const [kind, setKind] = useState('')
  const [applied, setApplied] = useState({ user: '', kind: '' })
  // the first row on screen: a new rows per page (Fit or a choice) shows the page that holds it
  const [firstRow, setFirstRow] = useState(0)
  const [playing, setPlaying] = useState<SessionRecording | null>(null)

  // the first row's height is measured once rows have come (recalculationKey)
  const [rowsIn, setRowsIn] = useState(false)
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ rowHeight: 41, recalculationKey: String(rowsIn) })
  const page = Math.floor(firstRow / rowsPerPage) + 1

  const { data: config } = useQuery({ queryKey: ['recordings', 'config'], queryFn: api.getRecordingsConfig, staleTime: 60_000 })
  // The server counts the matches (X-Kubeast-Total). The rows on screen stay while another page, search or page size
  // loads, with the range and rows per page they are.
  const { data, isLoading, refetch, isFetching, error: listError, errorUpdatedAt } = useQuery({
    queryKey: ['recordings', 'list', applied, page, rowsPerPage],
    queryFn: async () => ({ page, limit: rowsPerPage, ...(await api.listRecordings({ ...applied, limit: rowsPerPage, offset: (page - 1) * rowsPerPage })) }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  })
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const shownPage = data?.page ?? page
  const shownLimit = data?.limit ?? rowsPerPage
  const hasRows = rows.length > 0
  useEffect(() => { if (hasRows) setRowsIn(true) }, [hasRows])

  const statusClass: Record<string, string> = {
    recording: 'bg-primary-900/40 text-primary-300 border-primary-800/60',
    uploading: 'bg-amber-900/40 text-amber-300 border-amber-800/60',
    uploaded: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60',
    interrupted: 'bg-red-900/40 text-red-300 border-red-800/60',
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-6">
      <div className="flex items-start justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary-600/20 rounded-lg">
            <Film className="w-6 h-6 text-primary-400" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold text-ink">{tr('recordings.title', 'Session recordings')}</h1>
            <p className="text-slate-400">{tr('recordings.subtitle', 'What users saw in pod exec and node shell terminals. Opening a recording is audited.')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="btn btn-primary flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> {tr('recordings.refresh', 'Refresh')}
        </button>
      </div>

      {config && !config.enabled && (
        <div className="shrink-0 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="recordings-disabled">
          {tr('recordings.disabled', 'Session recording is off on this installation (sessionRecording.enabled). Earlier recordings stay listed.')}
        </div>
      )}

      <RefreshFailure failure={rows.length ? failureOf(listError, errorUpdatedAt) : null} />
      <div ref={containerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="flex flex-wrap items-end gap-3 mb-4 shrink-0">
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">{tr('recordings.filter.user', 'User')}</label>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="user@example.com"
              className="w-60 h-10 rounded-lg border border-slate-700 bg-slate-950/60 px-3 text-sm text-ink"
            />
          </div>
          <div className="w-44">
            <CustomDropdown
              label={tr('recordings.filter.kind', 'Kind')}
              value={kind}
              onChange={setKind}
              options={[
                { value: '', label: tr('recordings.kind.all', 'All') },
                { value: 'exec', label: tr('recordings.kind.exec', 'Pod exec') },
                { value: 'node-shell', label: tr('recordings.kind.nodeShell', 'Node shell') },
              ]}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setApplied({ user: user.trim(), kind })
              setFirstRow(0)
            }}
            className="h-10 rounded-lg bg-primary-600 px-3 text-sm font-medium text-white hover:bg-primary-500"
          >
            {tr('recordings.filter.apply', 'Search')}
          </button>
        </div>

        <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm" data-testid="recordings-table">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">{tr('recordings.col.started', 'Started')}</th>
                <th className="px-3 py-2 text-left">{tr('recordings.col.user', 'User')}</th>
                <th className="px-3 py-2 text-left">{tr('recordings.col.kind', 'Kind')}</th>
                <th className="px-3 py-2 text-left">{tr('recordings.col.target', 'Target')}</th>
                <th className="px-3 py-2 text-left">{tr('recordings.col.cluster', 'Cluster')}</th>
                <th className="px-3 py-2 text-right">{tr('recordings.col.size', 'Size')}</th>
                <th className="px-3 py-2 text-left">{tr('recordings.col.status', 'Status')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={COLUMNS} className="px-3 py-6 text-center text-slate-500">{tr('recordings.loading', 'Loading…')}</td></tr>
              ) : rows.length === 0 ? (
                <TableEmptyRow colSpan={COLUMNS} resource="recordings" error={listError} onRetry={() => void refetch()} className="px-3 py-6 text-center text-slate-400" />
              ) : (
                rows.map((r, idx) => (
                  <tr key={r.id} ref={idx === 0 ? firstRowRef : undefined} className="border-t border-slate-700" data-testid={`recording-row-${r.id}`}>
                    <td className="px-3 py-2 text-slate-300 whitespace-nowrap" title={utcTitle(r.started_at)}>{formatWhen(r.started_at)}</td>
                    <td className="px-3 py-2 text-slate-200"><span className="block max-w-[200px] truncate" title={r.user_email || undefined}>{r.user_email || '-'}</span></td>
                    <td className="px-3 py-2 text-slate-300">{r.kind === 'exec' ? tr('recordings.kind.exec', 'Pod exec') : tr('recordings.kind.nodeShell', 'Node shell')}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-200">
                      <span className="block max-w-[280px] truncate" title={targetText(r)}>{targetText(r)}</span>
                    </td>
                    <td className="px-3 py-2 text-slate-300">{r.cluster}</td>
                    <td
                      className="px-3 py-2 text-right text-slate-300"
                      title={keptBytes(r) < r.bytes ? tr('recordings.sizeKept', '{{kept}} kept of {{recorded}} recorded', { kept: formatBytes(keptBytes(r)), recorded: formatBytes(r.bytes) }) : undefined}
                    >
                      {formatBytes(keptBytes(r))}
                      {r.truncated && <span className="ml-1 text-amber-300" title={tr('recordings.truncated', 'Recording stopped at the size limit')}>✂</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block whitespace-nowrap rounded-sm border px-2 py-0.5 text-xs ${statusClass[r.status] ?? ''}`}
                        title={
                          r.status === 'interrupted'
                            ? r.parts === 0
                              ? tr('recordings.interruptedNothing', 'The server stopped before the first part was uploaded: nothing to play')
                              : tr('recordings.interruptedPartial', 'The server stopped during the recording: only the parts uploaded before are kept')
                            : r.last_error
                              ? tr('recordings.lastError', 'Last error: {{error}}', { error: r.last_error })
                              : undefined
                        }
                      >
                        {tr(`recordings.status.${r.status}`, r.status)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={r.parts === 0}
                        onClick={() => setPlaying(r)}
                        data-testid={`recording-play-${r.id}`}
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-primary-600 px-2 py-1 text-xs text-white hover:bg-primary-500 disabled:opacity-40"
                      >
                        <Play className="w-3.5 h-3.5" /> {tr('recordings.play', 'Play')}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - rows.length} columnCount={COLUMNS} cellClassName="py-2" />
          </table>
        </div>

        <ListPager
          currentPage={shownPage}
          totalPages={Math.max(1, Math.ceil(total / shownLimit))}
          total={total}
          rowsPerPage={shownLimit}
          onPageChange={(p) => setFirstRow((p - 1) * shownLimit)}
          testId="recordings-pager"
        />
      </div>

      {playing && (
        <RecordingPlayerModal
          recordingId={playing.id}
          title={`${playing.user_email ?? ''} · ${playing.namespace ? playing.namespace + '/' : ''}${playing.target} · ${playing.cluster} · ${formatWhen(playing.started_at)}`}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  )
}
