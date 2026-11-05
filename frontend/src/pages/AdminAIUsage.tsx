import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import CustomDropdown from '@/components/CustomDropdown'
import { api } from '@/services/api'
import type { AIUsageGroup, AIUsageRow } from '@/services/api'
import { formatDate, formatTime, parseTypedTime, utcTitle } from '@/utils/time'
import { DateTextInput } from '@/components/DateTextInput'
import { ListPager } from '@/components/ListPager'
import { avgPromptChars, cachedPercent, isInvestigationRow, usageCuts, usageRowKey, usageTotals } from './aiUsageView'

// Admin view over the ai.chat.complete audit records (chat turns, Optimization
// explanations) and, in rows of their own, the ai.investigation.run records:
// who used the AI how much in a period (requests, tokens, tool calls).
// Visibility instead of a quota — the operator decides what to do when a bill
// looks wrong. Totals and the cut come from the server.

const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 25

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '-'
}

export default function AdminAIUsage() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, unknown>) =>
    t(key, { defaultValue: fallback, ...options })

  const [sinceDay, setSinceDay] = useState(() => formatDate(Date.now() - 30 * DAY_MS))
  const [untilDay, setUntilDay] = useState(() => formatDate(Date.now()))
  const [group, setGroup] = useState<AIUsageGroup>('user')
  const [page, setPage] = useState(1)

  // Days are inclusive on both ends; the API takes [since, until). A day that is
  // not typed as YYYY-MM-DD yet keeps the last report on screen.
  const { query, rangeOk } = useMemo(() => {
    const since = parseTypedTime(sinceDay)
    const until = parseTypedTime(untilDay)
    return {
      rangeOk: !!since && !!until && since <= until,
      query: {
        since: since?.toISOString() ?? '',
        until: until ? new Date(until.getTime() + DAY_MS).toISOString() : '',
        group,
      },
    }
  }, [sinceDay, untilDay, group])

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin-ai-usage', query],
    queryFn: () => api.adminAIUsage(query),
    enabled: rangeOk,
    placeholderData: (previous) => previous,
    // Each read is itself audited (admin.audit.read), so no background polling.
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })

  const rows: AIUsageRow[] = useMemo(() => data?.rows ?? [], [data?.rows])
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const partialTokens = rows.some((r) => r.token_requests < r.requests)
  const totals = usageTotals(data)
  const cuts = usageCuts(data)
  // the rows on screen are the answer's: while another group loads they keep their own heading
  const shownGroup: AIUsageGroup = data?.group ?? group

  const groupLabel: Record<AIUsageGroup, string> = {
    user: tr('adminAIUsage.group.user', '사용자'),
    model: tr('adminAIUsage.group.model', '모델'),
    cluster: tr('adminAIUsage.group.cluster', '클러스터'),
  }
  const sourceLabel = {
    chat: tr('adminAIUsage.source.chat', 'Chat and Optimization'),
    investigation: tr('adminAIUsage.source.investigation', 'Alert investigations'),
  }
  const num = (n: number | undefined) => (n === undefined ? '-' : fmtInt(n))

  return (
    <div className="page-scrolls space-y-4">
      <div className="page-head items-center">
        <div>
          <h1 className="text-3xl font-semibold text-ink">{tr('adminAIUsage.title', 'AI 사용량')}</h1>
          <p className="text-slate-400 text-sm mt-1">
            {tr('adminAIUsage.subtitle', 'The audit records written per chat turn, per Optimization AI explanation and per alert investigation, added up — requests, tokens, tool calls. Alert investigations are rows of their own, never added into a chat row. No quota; see who used how much.')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="btn btn-primary flex items-center gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          {tr('common.refresh', '새로고침')}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <label className="block text-xs font-semibold text-slate-400">
          {tr('adminAIUsage.since', '시작일')}
          <DateTextInput value={sinceDay} onChange={(v) => { setSinceDay(v); setPage(1) }} className="h-8" testId="ai-usage-since" />
        </label>
        <label className="block text-xs font-semibold text-slate-400">
          {tr('adminAIUsage.until', '종료일')}
          <DateTextInput value={untilDay} onChange={(v) => { setUntilDay(v); setPage(1) }} className="h-8" testId="ai-usage-until" />
        </label>
        <CustomDropdown
          size="sm"
          className="w-36"
          label={tr('adminAIUsage.groupBy', '기준')}
          testId="ai-usage-group"
          value={group}
          onChange={(v) => { setGroup(v as AIUsageGroup); setPage(1) }}
          options={(['user', 'model', 'cluster'] as AIUsageGroup[]).map((g) => ({ value: g, label: groupLabel[g] }))}
        />
        <div className="ml-auto text-xs text-slate-400 text-right leading-5">
          <div>
            {tr('adminAIUsage.totals', '합계')}: {num(totals?.all.requests)} {tr('adminAIUsage.requests', '요청')} ·{' '}
            {num(totals?.all.total_tokens)} {tr('adminAIUsage.tokens', '토큰')} · {num(totals?.all.tool_calls)} {tr('adminAIUsage.toolCalls', '툴 호출')}
            {totals && totals.all.failures > 0 ? ` · ${fmtInt(totals.all.failures)} ${tr('adminAIUsage.failures', '실패')}` : ''}
          </div>
          <div>
            {sourceLabel.chat}: {num(totals?.chat.total_tokens)} {tr('adminAIUsage.tokens', '토큰')} ({num(totals?.chat.requests)} {tr('adminAIUsage.requests', '요청')}) ·{' '}
            {sourceLabel.investigation}: {num(totals?.investigation.total_tokens)} {tr('adminAIUsage.tokens', '토큰')} ({num(totals?.investigation.requests)} {tr('adminAIUsage.runs', 'runs')})
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-800">
        <div className="overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="ai-usage-table">
          <thead className="bg-slate-900/60 text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">{groupLabel[shownGroup]}</th>
              <th className="px-3 py-2 text-right">{tr('adminAIUsage.requests', '요청')}</th>
              <th className="px-3 py-2 text-right">{tr('adminAIUsage.promptTokens', '입력 토큰')}</th>
              <th className="px-3 py-2 text-right">{tr('adminAIUsage.cachedTokens', '캐시 적중')}</th>
              <th className="px-3 py-2 text-right">{tr('adminAIUsage.completionTokens', '출력 토큰')}</th>
              <th className="px-3 py-2 text-right">{tr('adminAIUsage.totalTokens', '합계 토큰')}</th>
              <th className="px-3 py-2 text-right">{tr('adminAIUsage.toolCalls', '툴 호출')}</th>
              <th className="px-3 py-2 text-right">{tr('adminAIUsage.avgDuration', '평균 소요(초)')}</th>
              <th className="px-3 py-2 text-right">{tr('adminAIUsage.failures', '실패')}</th>
              <th className="px-3 py-2 text-left">{tr('adminAIUsage.lastAt', '마지막')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-slate-500">
                  {tr('common.loading', '불러오는 중…')}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-slate-500">
                  {tr('common.noSearchResults', 'No results found.')}
                </td>
              </tr>
            ) : (
              pageRows.map((r) => {
                const investigation = isInvestigationRow(r)
                const chars = avgPromptChars(r)
                const cachedPct = cachedPercent(r)
                return (
                <tr key={usageRowKey(r)} className="border-t border-slate-800 hover:bg-slate-900/40">
                  <td className="px-3 py-2 text-slate-100">
                    <div className="flex items-center gap-2">
                      <span className="block max-w-[240px] truncate" title={r.key || undefined}>{r.key || '-'}</span>
                      {investigation && <span className="badge badge-neutral" data-testid="ai-usage-source-investigation">{tr('adminAIUsage.source.investigationRow', 'Alert investigation')}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-slate-200">{fmtInt(r.requests)}</td>
                  <td
                    className="px-3 py-2 text-right text-slate-300"
                    title={chars === null ? undefined : tr('adminAIUsage.avgPromptChars', '보낸 프롬프트 평균 {{n}}자(시스템·도구 정의·이력·메시지)', { n: fmtInt(chars) })}
                  >
                    {fmtInt(r.prompt_tokens)}
                  </td>
                  <td
                    className="px-3 py-2 text-right text-slate-300"
                    title={cachedPct === null ? undefined : tr('adminAIUsage.cachedShare', '입력 토큰 중 {{pct}}%가 제공자 캐시에서 왔습니다.', { pct: cachedPct })}
                  >
                    {typeof r.cached_tokens === 'number' ? fmtInt(r.cached_tokens) : '-'}
                    {cachedPct !== null && r.prompt_tokens > 0 ? <span className="ml-1 text-xs text-slate-500">{cachedPct}%</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300">{fmtInt(r.completion_tokens)}</td>
                  <td className="px-3 py-2 text-right text-slate-100">
                    {fmtInt(r.total_tokens)}
                    {r.token_requests < r.requests ? (
                      <span
                        className="ml-1 text-xs text-amber-400"
                        title={investigation
                          ? tr('adminAIUsage.partialRuns', '{{n}} run(s) recorded no token count (failed before the end, or the provider sent none) and are not in the sum', { n: r.requests - r.token_requests })
                          : tr('adminAIUsage.partialTokens', '{{n}}건은 제공자가 토큰 수를 보내지 않아 합계에 없음', { n: r.requests - r.token_requests })}
                      >
                        *
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300">{fmtInt(r.tool_calls)}</td>
                  <td className="px-3 py-2 text-right text-slate-300">{(r.avg_duration_ms / 1000).toFixed(1)}</td>
                  <td className={`px-3 py-2 text-right ${r.failures > 0 ? 'text-red-300' : 'text-slate-500'}`}>{fmtInt(r.failures)}</td>
                  <td className="px-3 py-2 text-slate-400 whitespace-nowrap" title={utcTitle(r.last_at)}>{formatTime(r.last_at)}</td>
                </tr>
                )
              })
            )}
          </tbody>
        </table>
        </div>
        <ListPager currentPage={currentPage} totalPages={pageCount} total={rows.length} rowsPerPage={PAGE_SIZE} onPageChange={setPage} showPageSize={false} testId="ai-usage-pager" />
      </div>
      <p className="text-xs text-slate-500">
        {cuts.map((c) => (
          <span key={c.source} className="mr-1 text-amber-400" data-testid={`ai-usage-cut-${c.source}`}>
            {tr('adminAIUsage.cut', '{{source}} by {{group}}: {{shown}} of {{groups}} listed, most tokens first; the totals count all {{groups}}.', {
              source: sourceLabel[c.source], group: groupLabel[shownGroup], shown: fmtInt(c.shown), groups: fmtInt(c.groups),
            })}
          </span>
        ))}
        {partialTokens && <span className="mr-1 text-amber-400" data-testid="ai-usage-partial-legend">* {tr('adminAIUsage.partialLegend', 'Some requests have no token count (the provider sent none, or an alert investigation failed before the end); the row total leaves them out.')}</span>}
        {tr('adminAIUsage.note', 'Token counts are added up only when the provider sends the usage value in its response. The raw records are in the audit log under the actions ai.chat.complete and ai.investigation.run, with CSV export.')}
      </p>
    </div>
  )
}
