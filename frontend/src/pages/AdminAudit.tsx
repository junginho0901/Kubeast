import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, AuditLogEntry, AuditLogFilter } from '@/services/api'
import { CheckCircle, ChevronDown, ChevronUp, Search } from 'lucide-react'

const SERVICES = ['', 'auth', 'k8s', 'helm', 'ai', 'admin']
const RESULTS = ['', 'success', 'failure']

// Custom dropdown — Kubeast 의 다른 곳 (ClusterView NamespaceDropdown / PodLogsTab
// Container dropdown 등) 과 동일 패턴. 외부 클릭 / ESC 로 close.
interface DropdownProps<T> {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  minWidth?: string
}

function CustomDropdown<T extends string | number>({
  value,
  options,
  onChange,
  minWidth = 'min-w-[120px]',
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  const selected = options.find((o) => o.value === value) ?? options[0]

  return (
    <div className="relative mt-1" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full ${minWidth} px-2 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 justify-between text-sm`}
      >
        <span className="font-medium truncate">{selected?.label ?? '-'}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-full bg-slate-800 border border-slate-600 rounded shadow-xl z-50 max-h-[300px] overflow-y-auto">
          {options.map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              onClick={() => {
                onChange(opt.value)
                setOpen(false)
              }}
              className="w-full px-3 py-2 text-left text-sm text-white hover:bg-slate-700 transition-colors flex items-center gap-2 first:rounded-t last:rounded-b"
            >
              {value === opt.value && (
                <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
              )}
              <span className={value === opt.value ? 'font-medium' : ''}>{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

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
            <CustomDropdown
              value={draft.service ?? ''}
              onChange={(v) => setDraft({ ...draft, service: v || undefined })}
              options={SERVICES.map((s) => ({
                value: s,
                label: s || tr('adminAudit.filter.any', '전체'),
              }))}
              minWidth="min-w-[140px]"
            />
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
            <CustomDropdown
              value={draft.result ?? ''}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  result: (v as 'success' | 'failure' | '') || undefined,
                })
              }
              options={RESULTS.map((r) => ({
                value: r,
                label: r || tr('adminAudit.filter.any', '전체'),
              }))}
              minWidth="min-w-[140px]"
            />
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
            <CustomDropdown
              value={draft.limit ?? 50}
              onChange={(v) => setDraft({ ...draft, limit: Number(v) })}
              options={[25, 50, 100, 200].map((n) => ({ value: n, label: String(n) }))}
              minWidth="min-w-[140px]"
            />
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
      {/* overflow-x-auto — 폭 좁은 모니터 (세로 모드 등) 에서 가로 스크롤 가능.
          table 의 min-w-[1100px] 로 컬럼이 너무 압축되지 않게 보장. */}
      <div className="rounded-lg bg-slate-800/30 border border-slate-700 overflow-x-auto">
        <table className="w-full min-w-[1100px] text-sm">
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
