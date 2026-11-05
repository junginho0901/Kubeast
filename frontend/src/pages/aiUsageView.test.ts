import { describe, expect, it } from 'vitest'
import type { AIUsageResponse, AIUsageRow, AIUsageTotals } from '@/services/api'
import { avgPromptChars, cachedPercent, isInvestigationRow, usageCuts, usageRowKey, usageTotals } from './aiUsageView'

const row = (o: Partial<AIUsageRow>): AIUsageRow => ({
  source: 'chat', key: 'a@example.com', requests: 4, failures: 0, prompt_tokens: 200, cached_tokens: 50, prompt_chars: 4000,
  completion_tokens: 20, total_tokens: 220, token_requests: 4, tool_calls: 2, avg_duration_ms: 1500, last_at: '2026-11-05T01:00:00Z', ...o,
})
const totals = (o: Partial<AIUsageTotals>): AIUsageTotals => ({
  groups: 0, rows: 0, requests: 0, failures: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, token_requests: 0, tool_calls: 0, truncated: false, ...o,
})

// 500 of 501 users listed: the rows add up to less than the totals the server counted
const listed = Array.from({ length: 500 }, (_, i) => row({ key: `u${i}@example.com`, total_tokens: 10_000 - i }))
const cutAnswer: AIUsageResponse = {
  since: '', until: '', group: 'user', limit: 500, truncated: true,
  rows: [...listed, row({ source: 'investigation', key: 'kubeast:investigator', total_tokens: 350, cached_tokens: null, prompt_chars: null })],
  totals: {
    chat: totals({ groups: 501, rows: 500, requests: 2004, total_tokens: 4_884_750, truncated: true }),
    investigation: totals({ groups: 1, rows: 1, requests: 2, total_tokens: 350 }),
    all: totals({ groups: 502, rows: 501, requests: 2006, total_tokens: 4_885_100, truncated: true }),
  },
}

describe('AI usage view', () => {
  it('takes the totals from the answer, not from the listed rows', () => {
    const t = usageTotals(cutAnswer)
    expect([t?.all.total_tokens, t?.chat.total_tokens, t?.investigation.total_tokens, t?.all.requests]).toEqual([4_885_100, 4_884_750, 350, 2006])
    expect(cutAnswer.rows.reduce((s, r) => s + r.total_tokens, 0)).toBe(4_885_100 - 9_500) // the 501st user is not listed
    expect(usageTotals({ ...cutAnswer, totals: null })).toBeNull()
  })

  it('says which source was cut, with the answer\'s counts', () => {
    expect(usageCuts(cutAnswer)).toEqual([{ source: 'chat', shown: 500, groups: 501 }])
    expect(usageCuts({ ...cutAnswer, totals: { ...cutAnswer.totals!, chat: totals({ groups: 500, rows: 500 }) } })).toEqual([])
    expect(usageCuts(undefined)).toEqual([])
  })

  it('keeps an investigation row apart from a chat row of the same key', () => {
    const chat = row({ key: 'claude-sonnet' })
    const inv = row({ source: 'investigation', key: 'claude-sonnet', cached_tokens: null, prompt_chars: null })
    expect([usageRowKey(chat), usageRowKey(inv)]).toEqual(['chat:claude-sonnet', 'investigation:claude-sonnet'])
    expect([isInvestigationRow(chat), isInvestigationRow(inv)]).toEqual([false, true])
  })

  it('leaves what an investigation does not record empty, not 0', () => {
    const inv = row({ source: 'investigation', cached_tokens: null, prompt_chars: null })
    expect([cachedPercent(inv), avgPromptChars(inv)]).toEqual([null, null])
    expect([cachedPercent(row({})), avgPromptChars(row({}))]).toEqual([25, 1000])
    expect([cachedPercent(row({ prompt_tokens: 0, cached_tokens: 0 })), avgPromptChars(row({ requests: 0 }))]).toEqual([0, 0])
  })
})
