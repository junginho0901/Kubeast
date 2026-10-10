import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import CustomDropdown from '@/components/CustomDropdown'
import { api } from '@/services/api'
import type { AIUsageGroup, AIUsageRow } from '@/services/api'

// Admin view over the ai.chat.complete audit records: who used the assistant
// how much in a period (requests, tokens, tool calls). Visibility instead of a
// quota — the operator decides what to do when a bill looks wrong.

const DAY_MS = 24 * 60 * 60 * 1000

function toDateInput(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '-'
}

export default function AdminAIUsage() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, unknown>) =>
    t(key, { defaultValue: fallback, ...options })

  const [sinceDay, setSinceDay] = useState(() => toDateInput(new Date(Date.now() - 30 * DAY_MS)))
  const [untilDay, setUntilDay] = useState(() => toDateInput(new Date()))
  const [group, setGroup] = useState<AIUsageGroup>('user')

  // Days are inclusive on both ends; the API takes [since, until).
  const query = useMemo(
    () => ({
      since: new Date(`${sinceDay}T00:00:00`).toISOString(),
      until: new Date(new Date(`${untilDay}T00:00:00`).getTime() + DAY_MS).toISOString(),
      group,
    }),
    [sinceDay, untilDay, group],
  )

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin-ai-usage', query],
    queryFn: () => api.adminAIUsage(query),
    // Each read is itself audited (admin.audit.read), so no background polling.
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })

  const rows: AIUsageRow[] = useMemo(() => data?.rows ?? [], [data?.rows])
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          requests: acc.requests + r.requests,
          failures: acc.failures + r.failures,
          prompt: acc.prompt + r.prompt_tokens,
          completion: acc.completion + r.completion_tokens,
          total: acc.total + r.total_tokens,
          tools: acc.tools + r.tool_calls,
        }),
        { requests: 0, failures: 0, prompt: 0, completion: 0, total: 0, tools: 0 },
      ),
    [rows],
  )

  const groupLabel: Record<AIUsageGroup, string> = {
    user: tr('adminAIUsage.group.user', '사용자'),
    model: tr('adminAIUsage.group.model', '모델'),
    cluster: tr('adminAIUsage.group.cluster', '클러스터'),
  }

  return (
    <div className="page-scrolls space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('adminAIUsage.title', 'AI 사용량')}</h1>
          <p className="text-slate-400 text-sm mt-1">
            {tr('adminAIUsage.subtitle', 'The audit records written per chat turn and per Optimization AI explanation, added up — requests, tokens, tool calls.')}
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
          <input
            type="date"
            value={sinceDay}
            max={untilDay}
            onChange={(e) => setSinceDay(e.target.value)}
            className="mt-1 block h-8 rounded-sm border border-slate-700 bg-slate-800 px-2 text-sm text-slate-100"
          />
        </label>
        <label className="block text-xs font-semibold text-slate-400">
          {tr('adminAIUsage.until', '종료일')}
          <input
            type="date"
            value={untilDay}
            min={sinceDay}
            onChange={(e) => setUntilDay(e.target.value)}
            className="mt-1 block h-8 rounded-sm border border-slate-700 bg-slate-800 px-2 text-sm text-slate-100"
          />
        </label>
        <CustomDropdown
          size="sm"
          className="w-36"
          label={tr('adminAIUsage.groupBy', '기준')}
          testId="ai-usage-group"
          value={group}
          onChange={(v) => setGroup(v as AIUsageGroup)}
          options={(['user', 'model', 'cluster'] as AIUsageGroup[]).map((g) => ({ value: g, label: groupLabel[g] }))}
        />
        <div className="ml-auto text-xs text-slate-400">
          {tr('adminAIUsage.totals', '합계')}: {fmtInt(totals.requests)} {tr('adminAIUsage.requests', '요청')} ·{' '}
          {fmtInt(totals.total)} {tr('adminAIUsage.tokens', '토큰')} · {fmtInt(totals.tools)} {tr('adminAIUsage.toolCalls', '툴 호출')}
          {totals.failures > 0 ? ` · ${fmtInt(totals.failures)} ${tr('adminAIUsage.failures', '실패')}` : ''}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="min-w-full text-sm" data-testid="ai-usage-table">
          <thead className="bg-slate-900/60 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">{groupLabel[group]}</th>
              <th className="px-3 py-2 text-right">{tr('adminAIUsage.requests', '요청')}</th>
              <th className="px-3 py-2 text-right">{tr('adminAIUsage.promptTokens', '입력 토큰')}</th>
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
                <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                  {tr('common.loading', '불러오는 중…')}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                  {tr('adminAIUsage.empty', '이 기간에 AI 채팅 기록이 없습니다.')}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.key} className="border-t border-slate-800 hover:bg-slate-900/40">
                  <td className="px-3 py-2 text-slate-100"><span className="block max-w-[240px] truncate" title={r.key || undefined}>{r.key || '-'}</span></td>
                  <td className="px-3 py-2 text-right text-slate-200">{fmtInt(r.requests)}</td>
                  <td className="px-3 py-2 text-right text-slate-300">{fmtInt(r.prompt_tokens)}</td>
                  <td className="px-3 py-2 text-right text-slate-300">{fmtInt(r.completion_tokens)}</td>
                  <td className="px-3 py-2 text-right text-slate-100">
                    {fmtInt(r.total_tokens)}
                    {r.token_requests < r.requests ? (
                      <span
                        className="ml-1 text-xs text-amber-400"
                        title={tr('adminAIUsage.partialTokens', '{{n}}건은 제공자가 토큰 수를 보내지 않아 합계에 없음', { n: r.requests - r.token_requests })}
                      >
                        *
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300">{fmtInt(r.tool_calls)}</td>
                  <td className="px-3 py-2 text-right text-slate-300">{(r.avg_duration_ms / 1000).toFixed(1)}</td>
                  <td className={`px-3 py-2 text-right ${r.failures > 0 ? 'text-red-300' : 'text-slate-500'}`}>{fmtInt(r.failures)}</td>
                  <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{r.last_at ? new Date(r.last_at).toLocaleString() : '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        {tr('adminAIUsage.note', 'Token counts are added up only when the provider sends the usage value in its response.')}
      </p>
    </div>
  )
}
