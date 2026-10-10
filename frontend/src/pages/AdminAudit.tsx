import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, AuditLogEntry, AuditLogFilter, AuditVerifyReport } from '@/services/api'
import { clustersApi } from '@/services/api/clusters'
import { CheckCircle, ChevronDown, ChevronUp, Play, Search } from 'lucide-react'
import { formatTime, parseTypedTime, utcTitle } from '@/utils/time'
import { DateTextInput } from '@/components/DateTextInput'
import RecordingPlayerModal from '@/components/RecordingPlayerModal'

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
        className={`w-full ${minWidth} h-10 px-2 bg-slate-900 hover:bg-slate-800 text-white rounded-sm border border-slate-600 focus:outline-hidden focus:border-primary-500 transition-colors flex items-center gap-2 justify-between text-sm`}
      >
        <span className="font-medium truncate">{selected?.label ?? '-'}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-full bg-slate-800 border border-slate-600 rounded-sm shadow-xl z-50 max-h-[300px] overflow-y-auto">
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
                <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
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
  const [playing, setPlaying] = useState<{ id: string; title: string } | null>(null)

  // Local draft for inputs; committed to `filter` on "Apply".
  const [draft, setDraft] = useState<AuditLogFilter>(filter)
  const [sinceText, setSinceText] = useState(() => (filter.since ? formatTime(filter.since).slice(0, 16) : ''))
  const [untilText, setUntilText] = useState(() => (filter.until ? formatTime(filter.until).slice(0, 16) : ''))

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

  // Audit log integrity: the chain state, one verification (since the last
  // anchor, with the digest objects when a sink is set) and "anchor now".
  const { data: integrity, refetch: refetchIntegrity } = useQuery({
    queryKey: ['admin-audit-integrity'],
    queryFn: () => api.getAuditIntegrity(),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
  const [verifyReport, setVerifyReport] = useState<AuditVerifyReport | null>(null)
  const [integrityError, setIntegrityError] = useState<string | null>(null)
  const failureText = (e: unknown) => {
    const err = e as { response?: { data?: { detail?: string } }; message?: string }
    return err?.response?.data?.detail || err?.message || 'failed'
  }
  const verifyMutation = useMutation({
    mutationFn: () => api.adminAuditVerify({ anchors: !!integrity?.anchor_sink }),
    onSuccess: (rep) => {
      setVerifyReport(rep)
      setIntegrityError(null)
    },
    onError: (e) => setIntegrityError(failureText(e)),
  })
  const anchorMutation = useMutation({
    mutationFn: () => api.adminAuditAnchor(),
    onSuccess: () => {
      setIntegrityError(null)
      refetchIntegrity()
    },
    onError: (e) => setIntegrityError(failureText(e)),
  })

  const { data: clusters = [] } = useQuery({
    queryKey: ['clusters-all'],
    queryFn: () => clustersApi.listClusters(false),
    staleTime: 60_000,
  })

  const total = data?.total ?? 0
  const items: AuditLogEntry[] = data?.items ?? []
  const limit = filter.limit ?? 50
  const offset = filter.offset ?? 0
  const page = Math.floor(offset / limit) + 1
  const totalPages = Math.max(1, Math.ceil(total / limit))

  // The time range is typed as local YYYY-MM-DD HH:mm; the API takes RFC 3339.
  const typedRange = (text: string) => {
    if (!text.trim()) return { ok: true, iso: undefined }
    const d = parseTypedTime(text, true)
    return { ok: !!d, iso: d?.toISOString() }
  }
  const since = typedRange(sinceText)
  const until = typedRange(untilText)
  const rangeOk = since.ok && until.ok

  const applyFilter = () => {
    if (!rangeOk) return
    setFilter({ ...draft, since: since.iso, until: until.iso, offset: 0 })
    setExpandedId(null)
  }

  const resetFilter = () => {
    const next: AuditLogFilter = { limit, offset: 0 }
    setDraft(next)
    setSinceText('')
    setUntilText('')
    setFilter(next)
    setExpandedId(null)
  }

  const goPage = (p: number) => {
    const newOffset = Math.max(0, (p - 1) * limit)
    setFilter({ ...filter, offset: newOffset })
    setExpandedId(null)
  }

  // CSV of everything matching the applied filter (not just this page). A
  // same-origin link download carries the session cookie; the server names
  // the file.
  const exportCsv = () => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filter)) {
      if (k === 'limit' || k === 'offset' || v === undefined || v === '') continue
      params.set(k, String(v))
    }
    const a = document.createElement('a')
    a.href = `/api/v1/auth/admin/audit-logs/export?${params.toString()}`
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const resultBadge = (result: string) => {
    const isSuccess = result === 'success'
    return (
      <span
        className={`inline-flex items-center whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium ${
          isSuccess
            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
            : 'bg-red-500/15 text-red-300 border border-red-500/30'
        }`}
      >
        {isSuccess ? '✓' : '✕'} {tr(`adminAudit.resultValue.${result}`, result)}
      </span>
    )
  }

  const fmtTime = (iso: string) => {
    return formatTime(iso)
  }

  return (
    <div className="page-scrolls space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('adminAudit.title', '감사 로그')}</h1>
          <p className="text-slate-400 text-sm mt-1">
            {tr('adminAudit.subtitle', '모든 쓰기 작업과 민감 열람 내역')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCsv}
            data-testid="audit-export-csv"
            className="btn btn-secondary flex items-center gap-2"
          >
            {tr('adminAudit.exportCsv', 'CSV 내보내기')}
          </button>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            {isFetching ? tr('adminAudit.refreshing', '불러오는 중...') : tr('adminAudit.refresh', '새로고침')}
          </button>
        </div>
      </div>

      {integrity?.enabled && (
        <div
          className="rounded-lg bg-slate-800/50 border border-slate-700 px-4 py-3 flex flex-wrap items-center gap-3 text-sm"
          data-testid="audit-integrity"
        >
          <span className="text-slate-300" title={tr('adminAudit.integrity.sealedTitle', 'Rows up to this number are chained by hash: a changed or removed row breaks the chain (Verify checks it)')}>
            {tr('adminAudit.integrity.sealed', '무결성: #{{seq}}까지 봉인', { seq: integrity.sealed_through_seq })}
            {integrity.unsealed_rows > 0 && (
              <span className="text-slate-500"> ({tr('adminAudit.integrity.unsealed', '미봉인 {{n}}', { n: integrity.unsealed_rows })})</span>
            )}
          </span>
          <span className="text-slate-600">·</span>
          <span className="text-slate-300" data-testid="audit-integrity-anchor-state" title={tr('adminAudit.integrity.anchorTitle', 'An anchor is a copy of the chain head written outside the database (the sink), so the chain can be checked against it')}>
            {integrity.last_anchor
              ? tr('adminAudit.integrity.lastAnchor', '마지막 앵커 {{when}} (#{{seq}} → {{sink}})', {
                  when: formatTime(integrity.last_anchor.created_at),
                  seq: integrity.last_anchor.to_seq,
                  sink: integrity.last_anchor.sink,
                })
              : integrity.anchor_sink
                ? tr('adminAudit.integrity.noAnchorYet', '앵커 아직 없음 ({{sink}})', { sink: integrity.anchor_sink })
                : tr('adminAudit.integrity.anchorOff', '앵커 꺼짐 (싱크 없음)')}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => verifyMutation.mutate()}
              disabled={verifyMutation.isPending}
              data-testid="audit-integrity-verify"
              className="rounded-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-1.5 text-sm text-white"
            >
              {verifyMutation.isPending ? tr('adminAudit.integrity.verifying', '검증 중...') : tr('adminAudit.integrity.verify', '검증')}
            </button>
            {integrity.anchor_sink && (
              <button
                type="button"
                onClick={() => anchorMutation.mutate()}
                disabled={anchorMutation.isPending}
                data-testid="audit-integrity-anchor"
                title={tr('adminAudit.integrity.anchorNowTitle', 'Write the head of the hash chain to the anchor sink now (it is also written on its own schedule)')}
                className="rounded-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-1.5 text-sm text-white"
              >
                {anchorMutation.isPending ? tr('adminAudit.integrity.anchoring', '앵커 중...') : tr('adminAudit.integrity.anchorNow', '지금 앵커')}
              </button>
            )}
          </div>
          {(verifyReport || integrityError) && (
            <div className="basis-full text-xs" data-testid="audit-integrity-result">
              {integrityError ? (
                <span className="text-red-400">{integrityError}</span>
              ) : verifyReport?.ok ? (
                <span className="text-green-400">
                  {tr('adminAudit.integrity.ok', '✓ #{{from}}~#{{to}} {{rows}}행 이상 없음, 앵커 {{anchors}}개 일치', {
                    from: verifyReport.from_seq,
                    to: verifyReport.to_seq,
                    rows: verifyReport.rows,
                    anchors: verifyReport.anchors.length,
                  })}
                </span>
              ) : (
                <span className="text-red-400">
                  {tr('adminAudit.integrity.bad', '✗ #{{from}}~#{{to}}: {{reason}} (#{{seq}})', {
                    from: verifyReport?.from_seq,
                    to: verifyReport?.to_seq,
                    reason: verifyReport?.reason,
                    seq: verifyReport?.first_bad_seq ?? '',
                  })}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="rounded-lg bg-slate-800/50 border border-slate-700 p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="flex flex-col text-xs font-semibold text-slate-400">
            {tr('adminAudit.filter.service', 'Area')}
            <CustomDropdown
              value={draft.service ?? ''}
              onChange={(v) => setDraft({ ...draft, service: v || undefined })}
              options={SERVICES.map((s) => ({
                value: s,
                label: s ? tr(`adminAudit.area.${s}`, s) : tr('adminAudit.filter.any', '전체'),
              }))}
              minWidth="min-w-[140px]"
            />
          </label>

          <label className="flex flex-col text-xs font-semibold text-slate-400" data-testid="audit-cluster-filter">
            {tr('adminAudit.filter.cluster', 'Cluster')}
            <CustomDropdown
              value={draft.cluster ?? ''}
              onChange={(v) => setDraft({ ...draft, cluster: v || undefined })}
              options={[
                { value: '', label: tr('adminAudit.filter.any', '전체') },
                ...clusters.map((c) => ({ value: c.id, label: c.display_name })),
              ]}
              minWidth="min-w-[140px]"
            />
          </label>

          <label className="flex flex-col text-xs font-semibold text-slate-400">
            {tr('adminAudit.filter.action', 'Action')}
            <input
              type="text"
              placeholder="k8s.pod.delete"
              className="mt-1 h-10 rounded-sm bg-slate-900 border border-slate-600 px-2 text-sm text-white"
              value={draft.action ?? ''}
              onChange={(e) => setDraft({ ...draft, action: e.target.value || undefined })}
            />
          </label>

          <label className="flex flex-col text-xs font-semibold text-slate-400">
            {tr('adminAudit.filter.actor', '사용자 이메일')}
            <input
              type="text"
              placeholder="user@example.com"
              className="mt-1 h-10 rounded-sm bg-slate-900 border border-slate-600 px-2 text-sm text-white"
              value={draft.actor_email ?? ''}
              onChange={(e) => setDraft({ ...draft, actor_email: e.target.value || undefined })}
            />
          </label>

          <label className="flex flex-col text-xs font-semibold text-slate-400">
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
                label: r ? tr(`adminAudit.resultValue.${r}`, r) : tr('adminAudit.filter.any', '전체'),
              }))}
              minWidth="min-w-[140px]"
            />
          </label>

          <label className="flex flex-col text-xs font-semibold text-slate-400">
            {tr('adminAudit.filter.namespace', 'Namespace')}
            <input
              type="text"
              className="mt-1 h-10 rounded-sm bg-slate-900 border border-slate-600 px-2 text-sm text-white"
              value={draft.namespace ?? ''}
              onChange={(e) => setDraft({ ...draft, namespace: e.target.value || undefined })}
            />
          </label>

          <label className="flex flex-col text-xs font-semibold text-slate-400">
            {tr('adminAudit.filter.since', '시작 시각')}
            <DateTextInput withTime value={sinceText} onChange={setSinceText} testId="audit-filter-since" />
          </label>

          <label className="flex flex-col text-xs font-semibold text-slate-400">
            {tr('adminAudit.filter.until', '종료 시각')}
            <DateTextInput withTime value={untilText} onChange={setUntilText} testId="audit-filter-until" />
          </label>

          <label className="flex flex-col text-xs font-semibold text-slate-400">
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
            disabled={!rangeOk}
            className="inline-flex items-center gap-1 rounded-sm bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-sm text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Search className="w-4 h-4" /> {tr('adminAudit.apply', '조회')}
          </button>
          <button
            onClick={resetFilter}
            className="rounded-sm bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-sm text-white"
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
          table 의 min-w-[1000px] 로 컬럼이 너무 압축되지 않게 보장. */}
      <div className="rounded-lg bg-slate-800/30 border border-slate-700 overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="bg-slate-800 text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">{tr('adminAudit.col.time', '시각')}</th>
              <th className="px-3 py-2 text-left">{tr('adminAudit.col.actor', '사용자')}</th>
              <th className="px-3 py-2 text-left">{tr('adminAudit.col.service', 'Area')}</th>
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
                  {tr('common.noSearchResults', 'No results found.')}
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
                onPlay={(id) => setPlaying({ id, title: `${entry.ActorEmail ?? ''} · ${entry.Action} · ${entry.TargetID ?? ''} · ${fmtTime(entry.CreatedAt)}` })}
                playLabel={tr('adminAudit.playRecording', 'Play recording')}
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
            className="rounded-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-40 px-3 py-1 text-white"
          >
            {tr('adminAudit.prev', '이전')}
          </button>
          <span className="text-slate-300">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => goPage(page + 1)}
            disabled={page >= totalPages}
            className="rounded-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-40 px-3 py-1 text-white"
          >
            {tr('adminAudit.next', '다음')}
          </button>
        </div>
      )}
      {playing && <RecordingPlayerModal recordingId={playing.id} title={playing.title} onClose={() => setPlaying(null)} />}
    </div>
  )
}

// recording_id is set on k8s.pod.exec / k8s.node.shell rows when the
// terminal was recorded.
function recordingIdOf(entry: AuditLogEntry): string | null {
  const after = entry.After as Record<string, unknown> | null | undefined
  const id = after && typeof after === 'object' ? after['recording_id'] : null
  return typeof id === 'string' && id ? id : null
}

interface AuditRowProps {
  entry: AuditLogEntry
  expanded: boolean
  onToggle: () => void
  resultBadge: (result: string) => React.ReactNode
  fmtTime: (iso: string) => string
  onPlay: (recordingId: string) => void
  playLabel: string
}

function AuditRow({ entry, expanded, onToggle, resultBadge, fmtTime, onPlay, playLabel }: AuditRowProps) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  // kubectl's kind/name form: a bare ID such as a role's "589" says nothing without its type
  const targetDisplay = entry.TargetEmail
    || (entry.TargetID ? (entry.TargetType ? `${entry.TargetType}/${entry.TargetID}` : entry.TargetID) : entry.TargetType)
    || '-'
  const recordingId = recordingIdOf(entry)

  return (
    <>
      <tr
        className={`border-t border-slate-700 hover:bg-slate-800/50 cursor-pointer ${
          entry.Result === 'failure' ? 'bg-red-950/20' : ''
        }`}
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-slate-300 whitespace-nowrap" title={utcTitle(entry.CreatedAt)}>{fmtTime(entry.CreatedAt)}</td>
        <td className="px-3 py-2 text-slate-200"><span className="block max-w-[170px] truncate" title={entry.ActorEmail || undefined}>{entry.ActorEmail || '-'}</span></td>
        <td className="px-3 py-2 text-slate-300" title={entry.Service || undefined}>{entry.Service ? tr(`adminAudit.area.${entry.Service}`, entry.Service) : '-'}</td>
        <td className="px-3 py-2 font-mono text-xs text-slate-200">{entry.Action}</td>
        <td className="px-3 py-2 text-slate-300"><span className="block max-w-[190px] truncate" title={targetDisplay}>{targetDisplay}</span></td>
        <td className="px-3 py-2 text-slate-400"><span className="block max-w-[120px] truncate" title={entry.Namespace || undefined}>{entry.Namespace || '-'}</span></td>
        <td className="px-3 py-2">
          {resultBadge(entry.Result || 'success')}
          {recordingId && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onPlay(recordingId) }}
              title={playLabel}
              aria-label={playLabel}
              data-testid={`audit-play-${recordingId}`}
              className="ml-2 inline-flex items-center rounded-sm border border-primary-700/60 bg-primary-900/30 px-1.5 py-0.5 text-[11px] text-primary-200 hover:bg-primary-800/40"
            >
              <Play className="w-3 h-3" />
            </button>
          )}
        </td>
        <td className="px-3 py-2 text-slate-400 text-right">
          {expanded ? <ChevronUp className="w-4 h-4 inline" /> : <ChevronDown className="w-4 h-4 inline" />}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-900/60">
          <td colSpan={8} className="px-4 py-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div>
                <div className="text-slate-400 mb-1">{tr('adminAudit.detail.httpContext', 'HTTP Context')}</div>
                <dl className="grid grid-cols-[100px_1fr] gap-y-1 text-slate-300">
                  <dt className="text-slate-500">IP</dt>
                  <dd>{entry.RequestIP || '-'}</dd>
                  <dt className="text-slate-500">User-Agent</dt>
                  <dd className="truncate">{entry.UserAgent || '-'}</dd>
                  <dt className="text-slate-500">Request-ID</dt>
                  <dd className="font-mono">{entry.RequestID || '-'}</dd>
                  <dt className="text-slate-500">Path</dt>
                  <dd className="font-mono break-all">{entry.Path || '-'}</dd>
                  <dt className="text-slate-500">{tr('adminAudit.filter.cluster', 'Cluster')}</dt>
                  <dd>{entry.Cluster || '-'}</dd>
                  <dt className="text-slate-500">{tr('adminAudit.detail.targetType', 'TargetType')}</dt>
                  <dd>{entry.TargetType || '-'}</dd>
                </dl>
              </div>
              <div>
                {entry.Error && (
                  <div className="mb-2">
                    <div className="text-red-400 mb-1">{tr('adminAudit.detail.error', 'Error')}</div>
                    <div className="rounded-sm bg-red-950/50 border border-red-800 p-2 text-red-200 font-mono">
                      {entry.Error}
                    </div>
                  </div>
                )}
                {entry.Before !== undefined && entry.Before !== null && (
                  <div className="mb-2">
                    <div className="text-slate-400 mb-1">{tr('adminAudit.detail.before', 'Before')}</div>
                    <pre className="rounded-sm bg-slate-950 border border-slate-700 p-2 text-slate-200 overflow-auto max-h-48">
                      {JSON.stringify(entry.Before, null, 2)}
                    </pre>
                  </div>
                )}
                {entry.After !== undefined && entry.After !== null && (
                  <div>
                    <div className="text-slate-400 mb-1">{tr('adminAudit.detail.after', 'After')}</div>
                    <pre className="rounded-sm bg-slate-950 border border-slate-700 p-2 text-slate-200 overflow-auto max-h-48">
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
