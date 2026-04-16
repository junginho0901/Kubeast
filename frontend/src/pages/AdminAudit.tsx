import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, AuditLogEntry, AuditLogFilter } from '@/services/api'
import { ChevronDown, ChevronUp, Search } from 'lucide-react'

const SERVICES = ['', 'auth', 'k8s', 'helm', 'ai', 'admin']
const RESULTS = ['', 'success', 'failure']

export default function AdminAudit() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const [filter, setFilter] = useState<AuditLogFilter>({ limit: 50, offset: 0 })
  const [expandedId, setExpandedId] = useState<number | null>(null)

  // Local draft for inputs; committed to `filter` on "Apply".
  const [draft, setDraft] = useState<AuditLogFilter>(filter)

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin-audit-logs', filter],
    queryFn: () => api.adminListAuditLogs(filter),
    placeholderData: keepPreviousData,
    // Audit log list is a read that itself produces an audit record
    // ("admin.audit.read"), so we want to poll sparingly. 60s is the minimum
    // automatic refetch interval; the user can hit "새로고침" for immediate
    // reads, and window-focus refetch is disabled for the same reason.
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  })

  const total = data?.total ?? 0
  const items: AuditLogEntry[] = data?.items ?? []
  const limit = filter.limit ?? 50
  const offset = filter.offset ?? 0
  const page = Math.floor(offset / limit) + 1
  const totalPages = Math.max(1, Math.ceil(total / limit))

  const applyFilter = () => {
    setFilter({ ...draft, offset: 0 })
    setExpandedId(null)
  }

  const resetFilter = () => {
    const next: AuditLogFilter = { limit, offset: 0 }
    setDraft(next)
    setFilter(next)
    setExpandedId(null)
  }

  const goPage = (p: number) => {
    const newOffset = Math.max(0, (p - 1) * limit)
    setFilter({ ...filter, offset: newOffset })
    setExpandedId(null)
  }

  const resultBadge = (result: string) => {
    const isSuccess = result === 'success'
    return (
      <span
        className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
          isSuccess
            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
            : 'bg-red-500/15 text-red-300 border border-red-500/30'
        }`}
      >
        {isSuccess ? '✓' : '✕'} {result}
      </span>
    )
  }

  const fmtTime = (iso: string) => {
    try {
      const d = new Date(iso)
      return d.toLocaleString()
    } catch {
      return iso
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('adminAudit.title', '감사 로그')}</h1>
          <p className="text-slate-400 text-sm mt-1">
            {tr('adminAudit.subtitle', '모든 쓰기 작업과 민감 열람 내역')}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-1.5 text-sm text-white"
        >
          {isFetching ? tr('adminAudit.refreshing', '불러오는 중...') : tr('adminAudit.refresh', '새로고침')}
        </button>
      </div>

      {/* Filters */}
      <div className="rounded-lg bg-slate-800/50 border border-slate-700 p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="flex flex-col text-xs text-slate-300">
            {tr('adminAudit.filter.service', 'Service')}
            <select
              className="mt-1 rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white"
              value={draft.service ?? ''}
              onChange={(e) => setDraft({ ...draft, service: e.target.value || undefined })}
            >
              {SERVICES.map((s) => (
                <option key={s || 'all'} value={s}>
                  {s || tr('adminAudit.filter.any', '전체')}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col text-xs text-slate-300">
            {tr('adminAudit.filter.action', 'Action')}
            <input
              type="text"
              placeholder="k8s.pod.delete"
              className="mt-1 rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white"
              value={draft.action ?? ''}
              onChange={(e) => setDraft({ ...draft, action: e.target.value || undefined })}
            />
          </label>

          <label className="flex flex-col text-xs text-slate-300">
            {tr('adminAudit.filter.actor', '사용자 이메일')}
            <input
              type="text"
              placeholder="user@kubeast.io"
              className="mt-1 rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white"
              value={draft.actor_email ?? ''}
              onChange={(e) => setDraft({ ...draft, actor_email: e.target.value || undefined })}
            />
          </label>

          <label className="flex flex-col text-xs text-slate-300">
            {tr('adminAudit.filter.result', '결과')}
            <select
              className="mt-1 rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white"
              value={draft.result ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  result: (e.target.value as 'success' | 'failure' | '') || undefined,
                })
              }
            >
              {RESULTS.map((r) => (
                <option key={r || 'all'} value={r}>
                  {r || tr('adminAudit.filter.any', '전체')}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col text-xs text-slate-300">
            {tr('adminAudit.filter.namespace', 'Namespace')}
            <input
              type="text"
              className="mt-1 rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white"
              value={draft.namespace ?? ''}
              onChange={(e) => setDraft({ ...draft, namespace: e.target.value || undefined })}
            />
          </label>

          <label className="flex flex-col text-xs text-slate-300">
            {tr('adminAudit.filter.since', '시작 시각')}
            <input
              type="datetime-local"
              className="mt-1 rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white"
              value={draft.since ? draft.since.slice(0, 16) : ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  since: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                })
              }
            />
          </label>

          <label className="flex flex-col text-xs text-slate-300">
            {tr('adminAudit.filter.until', '종료 시각')}
            <input
              type="datetime-local"
              className="mt-1 rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white"
              value={draft.until ? draft.until.slice(0, 16) : ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  until: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                })
              }
            />
          </label>

          <label className="flex flex-col text-xs text-slate-300">
            {tr('adminAudit.filter.limit', '페이지당 건수')}
            <select
              className="mt-1 rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white"
              value={draft.limit ?? 50}
              onChange={(e) => setDraft({ ...draft, limit: Number(e.target.value) })}
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex gap-2 mt-3">
          <button
            onClick={applyFilter}
            className="inline-flex items-center gap-1 rounded bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-sm text-white"
          >
            <Search className="w-4 h-4" /> {tr('adminAudit.apply', '조회')}
          </button>
          <button
            onClick={resetFilter}
            className="rounded bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-sm text-white"
          >
            {tr('adminAudit.reset', '초기화')}
          </button>
          <span className="ml-auto text-xs text-slate-400 self-center">
            {tr('adminAudit.total', '총 {{total}}건', { total })}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg bg-slate-800/30 border border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-3 py-2 text-left">{tr('adminAudit.col.time', '시각')}</th>
              <th className="px-3 py-2 text-left">{tr('adminAudit.col.actor', '사용자')}</th>
              <th className="px-3 py-2 text-left">{tr('adminAudit.col.service', 'Service')}</th>
              <th className="px-3 py-2 text-left">{tr('adminAudit.col.action', 'Action')}</th>
              <th className="px-3 py-2 text-left">{tr('adminAudit.col.target', '대상')}</th>
              <th className="px-3 py-2 text-left">{tr('adminAudit.col.namespace', 'Namespace')}</th>
              <th className="px-3 py-2 text-left">{tr('adminAudit.col.result', '결과')}</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                  {tr('adminAudit.loading', '불러오는 중...')}
                </td>
              </tr>
            )}
            {!isLoading && items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                  {tr('adminAudit.empty', '조건에 맞는 감사 로그가 없습니다')}
                </td>
              </tr>
            )}
            {items.map((entry) => (
              <AuditRow
                key={entry.ID}
                entry={entry}
                expanded={expandedId === entry.ID}
                onToggle={() => setExpandedId(expandedId === entry.ID ? null : entry.ID)}
                resultBadge={resultBadge}
                fmtTime={fmtTime}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 text-sm">
          <button
            onClick={() => goPage(page - 1)}
            disabled={page <= 1}
            className="rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 px-3 py-1 text-white"
          >
            {tr('adminAudit.prev', '이전')}
          </button>
          <span className="text-slate-300">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => goPage(page + 1)}
            disabled={page >= totalPages}
            className="rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 px-3 py-1 text-white"
          >
            {tr('adminAudit.next', '다음')}
          </button>
        </div>
      )}
    </div>
  )
}

interface AuditRowProps {
  entry: AuditLogEntry
  expanded: boolean
  onToggle: () => void
  resultBadge: (result: string) => React.ReactNode
  fmtTime: (iso: string) => string
}

function AuditRow({ entry, expanded, onToggle, resultBadge, fmtTime }: AuditRowProps) {
  const targetDisplay = entry.TargetEmail || entry.TargetID || '-'

  return (
    <>
      <tr
        className={`border-t border-slate-700 hover:bg-slate-800/50 cursor-pointer ${
          entry.Result === 'failure' ? 'bg-red-950/20' : ''
        }`}
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{fmtTime(entry.CreatedAt)}</td>
        <td className="px-3 py-2 text-slate-200">{entry.ActorEmail || '-'}</td>
        <td className="px-3 py-2 text-slate-300">{entry.Service || '-'}</td>
        <td className="px-3 py-2 font-mono text-xs text-slate-200">{entry.Action}</td>
        <td className="px-3 py-2 text-slate-300">{targetDisplay}</td>
        <td className="px-3 py-2 text-slate-400">{entry.Namespace || '-'}</td>
        <td className="px-3 py-2">{resultBadge(entry.Result || 'success')}</td>
        <td className="px-3 py-2 text-slate-400 text-right">
          {expanded ? <ChevronUp className="w-4 h-4 inline" /> : <ChevronDown className="w-4 h-4 inline" />}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-900/60">
          <td colSpan={8} className="px-4 py-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div>
                <div className="text-slate-400 mb-1">HTTP Context</div>
                <dl className="grid grid-cols-[100px_1fr] gap-y-1 text-slate-300">
                  <dt className="text-slate-500">IP</dt>
                  <dd>{entry.RequestIP || '-'}</dd>
                  <dt className="text-slate-500">User-Agent</dt>
                  <dd className="truncate">{entry.UserAgent || '-'}</dd>
                  <dt className="text-slate-500">Request-ID</dt>
                  <dd className="font-mono">{entry.RequestID || '-'}</dd>
                  <dt className="text-slate-500">Path</dt>
                  <dd className="font-mono break-all">{entry.Path || '-'}</dd>
                  <dt className="text-slate-500">Cluster</dt>
                  <dd>{entry.Cluster || '-'}</dd>
                  <dt className="text-slate-500">TargetType</dt>
                  <dd>{entry.TargetType || '-'}</dd>
                </dl>
              </div>
              <div>
                {entry.Error && (
                  <div className="mb-2">
                    <div className="text-red-400 mb-1">Error</div>
                    <div className="rounded bg-red-950/50 border border-red-800 p-2 text-red-200 font-mono">
                      {entry.Error}
                    </div>
                  </div>
                )}
                {entry.Before !== undefined && entry.Before !== null && (
                  <div className="mb-2">
                    <div className="text-slate-400 mb-1">Before</div>
                    <pre className="rounded bg-slate-950 border border-slate-700 p-2 text-slate-200 overflow-auto max-h-48">
                      {JSON.stringify(entry.Before, null, 2)}
                    </pre>
                  </div>
                )}
                {entry.After !== undefined && entry.After !== null && (
                  <div>
                    <div className="text-slate-400 mb-1">After</div>
                    <pre className="rounded bg-slate-950 border border-slate-700 p-2 text-slate-200 overflow-auto max-h-48">
                      {JSON.stringify(entry.After, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
