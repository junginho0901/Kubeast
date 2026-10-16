import type { TFunction } from 'i18next'

// The token usage an assistant answer keeps of its turn (messages.usage, written by ai-service): the same sums as
// the turn's ai.chat.complete audit row.
export interface TurnUsage {
  prompt_tokens: number
  completion_tokens: number
  cached_tokens?: number
  model_calls?: number
  model?: string | null
}

// "In 15,041 · out 120 tokens · 99% cached" under the answer; the tooltip names the model calls and the model.
export function turnUsageText(t: TFunction, usage?: TurnUsage | null): { text: string; title: string } | null {
  if (!usage || typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') return null
  let text = t('aiChat.turnUsage.line', {
    prompt: usage.prompt_tokens.toLocaleString(),
    completion: usage.completion_tokens.toLocaleString(),
  })
  if (usage.prompt_tokens > 0 && typeof usage.cached_tokens === 'number') {
    text += t('aiChat.turnUsage.cached', { pct: Math.round((usage.cached_tokens / usage.prompt_tokens) * 100) })
  }
  const title = t('aiChat.turnUsage.calls', { count: usage.model_calls ?? 0, model: usage.model || '-' })
  return { text, title }
}
