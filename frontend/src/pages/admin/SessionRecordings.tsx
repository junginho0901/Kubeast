import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Film, Play, RefreshCw } from 'lucide-react'

import { api } from '@/services/api'
import type { SessionRecording } from '@/services/api/recordings'
import CustomDropdown from '@/components/CustomDropdown'
import RecordingPlayerModal from '@/components/RecordingPlayerModal'
import { formatWhen } from './accessRequestFormat'

// Admin → Session recordings: recorded pod exec / node shell terminals (the
// output the user saw). Opening one replays it; every read is audited.

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1 << 20)).toFixed(1)} MiB`
}

export default function SessionRecordings() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const [user, setUser] = useState('')
  const [kind, setKind] = useState('')
  const [applied, setApplied] = useState({ user: '', kind: '' })
  const [playing, setPlaying] = useState<SessionRecording | null>(null)

  const { data: config } = useQuery({ queryKey: ['recordings', 'config'], queryFn: api.getRecordingsConfig, staleTime: 60_000 })
  const { data: rows = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['recordings', 'list', applied],
    queryFn: () => api.listRecordings(applied),
    refetchInterval: 15_000,
  })

  const statusClass: Record<string, string> = {
    recording: 'bg-sky-900/40 text-sky-300 border-sky-800/60',
    uploading: 'bg-amber-900/40 text-amber-300 border-amber-800/60',
    uploaded: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60',
    interrupted: 'bg-red-900/40 text-red-300 border-red-800/60',
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary-600/20 rounded-lg">
            <Film className="w-6 h-6 text-primary-400" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-white">{tr('recordings.title', 'Session recordings')}</h1>
            <p className="text-slate-400">{tr('recordings.subtitle', 'What users saw in pod exec and node shell terminals. Opening a recording is audited.')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> {tr('recordings.refresh', 'Refresh')}
        </button>
      </div>

      {config && !config.enabled && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200" data-testid="recordings-disabled">
          {tr('recordings.disabled', 'Session recording is off on this installation (sessionRecording.enabled). Earlier recordings stay listed.')}
        </div>
      )}

      <div className="card">
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">{tr('recordings.filter.user', 'User')}</label>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="alice@example.com"
              className="w-60 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-white"
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
            onClick={() => setApplied({ user: user.trim(), kind })}
            className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-500"
          >
            {tr('recordings.filter.apply', 'Search')}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="recordings-table">
            <thead className="text-xs uppercase text-slate-400">
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
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">{tr('recordings.loading', 'Loading…')}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">{tr('recordings.empty', 'No recordings')}</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-700" data-testid={`recording-row-${r.id}`}>
                    <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{formatWhen(r.started_at)}</td>
                    <td className="px-3 py-2 text-slate-200">{r.user_email || '-'}</td>
                    <td className="px-3 py-2 text-slate-300">{r.kind === 'exec' ? tr('recordings.kind.exec', 'Pod exec') : tr('recordings.kind.nodeShell', 'Node shell')}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-200">
                      {r.namespace ? `${r.namespace}/` : ''}{r.target}{r.container ? ` (${r.container})` : ''}
                    </td>
                    <td className="px-3 py-2 text-slate-300">{r.cluster}</td>
                    <td className="px-3 py-2 text-right text-slate-300">
                      {formatBytes(r.bytes || r.uploaded_bytes)}
                      {r.truncated && <span className="ml-1 text-amber-300" title={tr('recordings.truncated', 'Recording stopped at the size limit')}>✂</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded-sm border px-2 py-0.5 text-xs ${statusClass[r.status] ?? ''}`} title={r.last_error ?? ''}>
                        {tr(`recordings.status.${r.status}`, r.status)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={r.parts === 0}
                        onClick={() => setPlaying(r)}
                        data-testid={`recording-play-${r.id}`}
                        className="inline-flex items-center gap-1 rounded-lg bg-primary-600 px-2 py-1 text-xs text-white hover:bg-primary-500 disabled:opacity-40"
                      >
                        <Play className="w-3.5 h-3.5" /> {tr('recordings.play', 'Play')}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
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
