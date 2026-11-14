import type { AIContextInput } from '@/hooks/useAIContext'
import type { HypothesisState, Investigation, InvestigationCallRef, InvestigationHypothesis, InvestigationResult } from '@/services/api/investigations'

// The report's result and hypothesis ledger (features.alertInvestigation.ledger): what the report window draws under the
// report and what it tells the floating chat. The texts in it came from a model, so the window draws them as plain text.

type Tr = (key: string, fallback: string, opts?: Record<string, unknown>) => string

export const HYPOTHESIS_ORDER: HypothesisState[] = ['cause', 'symptom', 'open', 'blocked', 'ruled_out']

// A state's colour: the cause red, a symptom and an open one amber, blocked the accent, ruled out grey.
export const stateBadge: Record<HypothesisState, string> = {
  cause: 'badge badge-error',
  symptom: 'badge badge-warning',
  open: 'badge badge-warning',
  blocked: 'badge badge-info',
  ruled_out: 'badge badge-neutral',
}

const STATE_TEXT: Record<HypothesisState, string> = {
  cause: 'Cause',
  symptom: 'Symptom',
  open: 'Open',
  blocked: 'Blocked',
  ruled_out: 'Ruled out',
}

export function stateText(state: HypothesisState, tr: Tr): string {
  return tr(`investigations.result.state.${state}`, STATE_TEXT[state] ?? state)
}

// "#3 prometheus_query": the call's number in the report's tool calls and its tool.
export function callLabel(ref: InvestigationCallRef): string {
  return `#${ref.call} ${ref.tool}`
}

// The hypotheses in the order an on-call engineer reads them: causes first, ruled out last, the model's order within.
export function orderedHypotheses(result: InvestigationResult): InvestigationHypothesis[] {
  return result.hypotheses
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (HYPOTHESIS_ORDER.indexOf(a.h.state) - HYPOTHESIS_ORDER.indexOf(b.h.state)) || a.i - b.i)
    .map(({ h }) => h)
}

const PROBLEM_TEXT: Record<string, string> = {
  open: 'no state of the four',
  no_evidence_for: 'no call that answered speaks for it',
  no_evidence_against: 'no call that answered speaks against it',
  no_reason: 'no reason why it is blocked',
  bad_calls: '{{calls}} name no call of this investigation',
}

// Why a hypothesis is not closed, as the window says it.
export function notClosedText(h: InvestigationHypothesis, tr: Tr): string {
  const reasons = (h.problems ?? []).map((p) => {
    const key = p.reason === 'no_evidence' ? `no_evidence_${p.side ?? 'for'}` : p.reason
    return tr(`investigations.result.problem.${key}`, PROBLEM_TEXT[key] ?? key, { calls: (p.calls ?? []).join(', ') })
  })
  return tr('investigations.result.notClosed', 'Not closed: {{reasons}}', { reasons: reasons.join('; ') })
}

// The lines above the result: a block the server could not read, the second ask.
export function resultNotes(result: InvestigationResult, tr: Tr): string[] {
  const notes: string[] = []
  if (result.status !== 'ok') {
    notes.push(tr('investigations.result.missing', 'The report did not end with a result block the server could read, so it has no causes or hypotheses to show.'))
  }
  if (result.asked_again) {
    notes.push(result.ask_failed
      ? tr('investigations.result.askFailed', 'The model was asked once more without tools and that call failed: this is the first report.')
      : tr('investigations.result.askedAgain', 'The model was asked once more without tools, because a cause or a hypothesis was not shown by the calls or the block was missing.'))
  }
  return notes
}

// The floating chat's layer is cut whole past 8 KB: the report it gets with a result, and each text of the result.
export const CHAT_REPORT_WITH_RESULT = 2048
const CHAT_TEXT = 120

const short = (s: string) => (s.length > CHAT_TEXT ? `${s.slice(0, CHAT_TEXT - 1)}…` : s)

// What the floating chat is told of the result, next to the report it already gets.
export function resultForChat(result: InvestigationResult): Record<string, unknown> {
  return {
    status: result.status,
    no_fault: result.no_fault,
    asked_again: result.asked_again,
    causes: result.causes.map((c) => ({ resource: c.resource, kind: c.kind, started_at: c.started_at, evidence: c.evidence.map(callLabel) })),
    path: result.path,
    ruled_out: result.ruled_out,
    hypotheses: orderedHypotheses(result).map((h) => ({
      statement: short(h.statement),
      resource: h.resource,
      state: h.state,
      closed: h.closed,
      for: h.for.map(callLabel),
      against: h.against.map(callLabel),
      ...(h.blocked ? { blocked: short(h.blocked) } : {}),
      ...(h.problems?.length ? { not_closed: h.problems.map((p) => p.reason) } : {}),
    })),
  }
}

// What the report window tells the floating chat: the report and its calls, and the result when the server kept one.
export function reportLayer(data: Investigation): AIContextInput {
  return {
    source: 'InvestigationModal',
    summary: `알림 조사 보고서 — ${data.alertname} (${data.cluster}${data.namespace ? ` / ${data.namespace}` : ''}, ${data.status})`,
    data: {
      alertname: data.alertname, cluster: data.cluster, namespace: data.namespace, severity: data.severity, status: data.status,
      labels: data.labels, received_at: data.received_at, model: data.model, iterations: data.iterations,
      tool_calls: data.tool_calls.map((c) => ({ tool: c.tool, args: c.args, error: c.error })),
      error: data.error || undefined, skip_reason: data.status === 'skipped' ? data.skip_reason || undefined : undefined,
      // With a result the report is cut shorter, so the layer stays within its 8 KB (past it enforceTokenBudget keeps
      // none of the data); the result holds the causes and hypotheses the report's end would.
      ...(data.result ? { result: resultForChat(data.result) } : {}),
      report: data.report.slice(0, data.result ? CHAT_REPORT_WITH_RESULT : 4096),
    },
  }
}
