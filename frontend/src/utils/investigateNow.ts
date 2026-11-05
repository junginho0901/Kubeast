import type { InvestigateNowState } from '@/services/api/alertInbox'
import { formatTime } from './time'

type Tr = (key: string, fallback: string, opts?: Record<string, unknown>) => string

// What the alert window's "Investigate now" shows, from the server's state: nothing when the user lacks
// resource.alert.investigate (hidden, as the other actions a role does not hold) or when the alert's investigation is
// queued, running or done; else the button, enabled or not, with one note — why not and when it works again (in the
// viewer's zone), or today's use of the budget. The numbers and times are the server's.
export interface InvestigateNowView {
  show: boolean
  enabled: boolean
  note: string
}

const HIDDEN: InvestigateNowView = { show: false, enabled: false, note: '' }
const WHY_FALLBACK: Record<string, string> = {
  manual_off: 'Turned off on this installation (features.alertInvestigation.manual).',
  provider_paused: 'The AI model provider refused an investigation: none starts until {{until}}.',
  manual_budget: "Today's token budget for asked-for investigations ({{budget}}) is used up: again from {{until}}.",
}

function whyText(code: string, until: string | null | undefined, budget: number, tr: Tr): string {
  return tr(`alertInbox.investigateNow.why.${code}`, WHY_FALLBACK[code] ?? code, {
    until: until ? formatTime(until) : '-',
    budget: budget.toLocaleString(),
  })
}

export function investigateNowView(state: InvestigateNowState | undefined, tr: Tr): InvestigateNowView {
  if (!state || state.reason === 'forbidden' || state.reason === 'investigating' || state.reason === 'investigated') return HIDDEN
  if (!state.allowed) return { show: true, enabled: false, note: whyText(state.reason, state.until, state.budget, tr) }
  const note = state.budget > 0
    ? tr('alertInbox.investigateNow.used', 'Asked-for investigations today: {{used}} of {{budget}} tokens (UTC day)', {
      used: state.used.toLocaleString(), budget: state.budget.toLocaleString(),
    })
    : ''
  return { show: true, enabled: true, note }
}

// Why a press was not started: the refusal's code with its time (the server's answer), the audit log, or "not started".
export function investigateErrorText(err: unknown, tr: Tr): string {
  const res = (err as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response
  if (res?.status === 503) return tr('alertInbox.investigateNow.auditUnavailable', 'Not started: the audit log cannot take the record right now.')
  const detail = res?.data?.detail as { code?: string; until?: string | null; budget?: number } | undefined
  if (detail && typeof detail === 'object' && detail.code && detail.code in WHY_FALLBACK) {
    return whyText(detail.code, detail.until, Number(detail.budget ?? 0), tr)
  }
  return tr('alertInbox.investigateNow.failed', 'Not started.')
}
