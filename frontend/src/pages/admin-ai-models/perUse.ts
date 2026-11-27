import type { ModelUseState } from '@/services/api'

export type Tr = (key: string, fb: string, o?: Record<string, unknown>) => string

/** The lines under a use's field: what answers it now, or why nothing would, and what its daily budget counts. */
export function linesOf(u: ModelUseState, tr: Tr): { text: string; problem?: boolean }[] {
  const lines: { text: string; problem?: boolean }[] = []
  if (u.choice && !u.choice.enabled) {
    lines.push({ text: tr('admin.aiModels.perUse.choiceDisabled', '"{{name}}" is disabled, so it does not answer.', { name: u.choice.name }), problem: true })
  }
  if (u.problem) {
    lines.push({ text: tr('admin.aiModels.perUse.problem', 'Does not run now: {{reason}}', { reason: u.problem }), problem: true })
  } else {
    lines.push({
      text: u.answers
        ? tr('admin.aiModels.perUse.answers', 'Answers now: {{name}}', { name: u.answers.name })
        : tr('admin.aiModels.perUse.answersChart', "Answers now: the model of the chart's ai.* values"),
    })
  }
  if (!u.on) lines.push({ text: tr('admin.aiModels.perUse.off', 'Off on this install') })
  if (u.daily_token_budget) {
    lines.push({
      text: tr('admin.aiModels.perUse.budget', 'Daily budget: {{tokens}} tokens (UTC). It counts tokens, not money, whichever model answers.', {
        tokens: u.daily_token_budget.toLocaleString('en-US'),
      }),
    })
  } else if (u.daily_token_budget === 0) {
    lines.push({ text: tr('admin.aiModels.perUse.noBudget', 'No daily budget.') })
  }
  return lines
}
