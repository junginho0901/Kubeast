import type { AIUsageResponse, AIUsageRow, AIUsageSource, AIUsageTotals } from '@/services/api'

// What the AI Usage page draws from one answer. Totals, group counts and the cut
// are the server's (every group of the period), never the listed rows added up.

export const USAGE_SOURCES: AIUsageSource[] = ['chat', 'investigation']

/** A row's React key: the same user, model or cluster can be a chat row and an investigation row. */
export const usageRowKey = (r: AIUsageRow): string => `${r.source ?? 'chat'}:${r.key}`

export const isInvestigationRow = (r: AIUsageRow): boolean => r.source === 'investigation'

/** The answer's totals, or null when it has none (then the line shows "-"). */
export function usageTotals(data: AIUsageResponse | undefined): { chat: AIUsageTotals; investigation: AIUsageTotals; all: AIUsageTotals } | null {
  return data?.totals ?? null
}

/** The sources whose groups were not all listed: how many are and of how many. */
export function usageCuts(data: AIUsageResponse | undefined): { source: AIUsageSource; shown: number; groups: number }[] {
  const totals = data?.totals
  if (!totals) return []
  return USAGE_SOURCES.filter((s) => totals[s].truncated).map((s) => ({ source: s, shown: totals[s].rows, groups: totals[s].groups }))
}

/** The average prompt sent, or null where the source's records do not count it. */
export function avgPromptChars(r: AIUsageRow): number | null {
  if (typeof r.prompt_chars !== 'number') return null
  return r.requests > 0 ? Math.round(r.prompt_chars / r.requests) : 0
}

/** The cached share of the prompt tokens in percent (0 without prompt tokens), or null where it is not recorded. */
export function cachedPercent(r: AIUsageRow): number | null {
  if (typeof r.cached_tokens !== 'number') return null
  return r.prompt_tokens > 0 ? Math.round((r.cached_tokens / r.prompt_tokens) * 100) : 0
}
