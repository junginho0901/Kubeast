import type { AIContextInput } from '@/hooks/useAIContext'
import type {
  HypothesisState, Investigation, InvestigationCallRef, InvestigationCause, InvestigationChecked, InvestigationCut, InvestigationHypothesis,
  InvestigationNotLookedAt, InvestigationOutcome, InvestigationResult, InvestigationVerdict,
} from '@/services/api/investigations'
import { MAX_LAYER_BYTES } from '@/utils/aiContext/tokenBudget'

// The report's result (evidenceCheck or ledger): what its window draws and what it tells the floating chat.

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
  not_verified: 'the evidence check did not verify the cause it is about',
}

// Why a hypothesis is not closed, as the window says it.
export function notClosedText(h: InvestigationHypothesis, tr: Tr): string {
  const reasons = (h.problems ?? []).map((p) => {
    const key = p.reason === 'no_evidence' ? `no_evidence_${p.side ?? 'for'}` : p.reason
    return tr(`investigations.result.problem.${key}`, PROBLEM_TEXT[key] ?? key, { calls: (p.calls ?? []).join(', ') })
  })
  return tr('investigations.result.notClosed', 'Not closed: {{reasons}}', { reasons: reasons.join('; ') })
}

// Whether the ledger read the block: a row written before `checks` was kept had it on.
export function ledgerOn(result: InvestigationResult): boolean {
  return result.checks?.ledger ?? true
}

const UNVERIFIED_TEXT: Record<string, string> = {
  no_evidence: 'no call is given for it',
  bad_calls: 'a call given is not a call of this investigation that answered',
  name_missing: 'its name does not appear in what the calls returned',
  after_alert: 'it starts after the alert did',
}

// A cause the run's calls do not show (evidenceCheck), as the window and the floating chat say it.
export function notVerifiedText(c: InvestigationCause, tr: Tr): string {
  const reason = c.reason ? tr(`investigations.result.unverified.${c.reason}`, UNVERIFIED_TEXT[c.reason] ?? c.reason) : ''
  return reason
    ? tr('investigations.result.notVerified', 'Not verified: {{reason}}', { reason })
    : tr('investigations.result.notVerifiedBare', 'Not verified')
}

export const outcomeBadge: Record<InvestigationOutcome, string> = {
  cause_found: 'badge badge-error',
  no_fault: 'badge badge-success',
  cannot_tell: 'badge badge-warning',
}

const OUTCOME_TEXT: Record<InvestigationOutcome, string> = { cause_found: 'Cause found', no_fault: 'No fault found', cannot_tell: 'Cannot tell' }

export function outcomeText(outcome: InvestigationOutcome, tr: Tr): string {
  return tr(`investigations.result.outcome.${outcome}`, OUTCOME_TEXT[outcome] ?? outcome)
}

const WHY_TEXT: Record<string, string> = {
  contradicts: 'the outcome, "no_fault" and the causes say different things',
  no_symptom: "no call is given that shows the alert's symptom",
  symptom_bad_calls: 'the calls given for the symptom are not calls of this investigation that answered',
  symptom_name_missing: "the symptom's object does not appear in what its calls returned",
  symptom_not_shown: 'the calls given for the symptom hold nothing or read only what changed, an alert or its rule, or names',
  cause_not_shown: 'no call shows any of its causes',
  nothing_read: 'no call of this investigation that read a state answered with something',
  not_read: "no call that read a state names the alert's object",
}

// Why the server keeps "cannot tell" of what the report concludes; '' when it keeps what the report says.
export function outcomeWhyText(v: InvestigationVerdict, tr: Tr): string {
  if (v.why.length === 0) return ''
  const reasons = v.why.map((reason) => tr(`investigations.result.outcomeWhy.${reason}`, WHY_TEXT[reason] ?? reason)).join('; ')
  return v.said
    ? tr('investigations.result.outcomeKept', 'Kept by the server. The report says "{{said}}", but {{reasons}}.', { said: outcomeText(v.said, tr), reasons })
    : tr('investigations.result.outcomeKeptBare', 'Kept by the server: {{reasons}}.', { reasons })
}

const SOURCE_TEXT: Record<string, string> = {
  objects: 'Objects', events: 'Events', changes: 'Changes', logs: 'Logs', metrics: 'Metrics', traces: 'Traces', network: 'Network', alerts: 'Alerts',
}

export function sourceText(source: string, tr: Tr): string {
  return tr(`investigations.result.source.${source}`, SOURCE_TEXT[source] ?? source)
}

// "restarts (apps, Deployment/web)": a check and where the server saw it.
export function checkText(c: Pick<InvestigationChecked, 'check' | 'namespace' | 'workload'>): string {
  const place = [c.namespace, c.workload].filter(Boolean).join(', ')
  return place ? `${c.check} (${place})` : c.check
}

const NOT_LOOKED_TEXT: Record<string, string> = {
  not_offered: 'the cluster offers no tool for it',
  not_called: 'no call read it',
  no_answer: 'the calls that read it gave no answer',
  not_run: 'the check did not run',
  failed: 'the call failed or was refused',
  unavailable: 'the cluster does not have it',
  not_found: 'not found',
}

// One thing the run did not look at, as the window and the floating chat say it.
export function notLookedAtText(n: InvestigationNotLookedAt, tr: Tr): string {
  const what = n.source ? sourceText(n.source, tr) : n.check ? checkText({ ...n, check: n.check }) : callLabel({ call: n.call ?? 0, tool: n.tool ?? '' })
  const reason = tr(`investigations.result.notLooked.${n.reason}`, NOT_LOOKED_TEXT[n.reason] ?? n.reason)
  return n.detail ? `${what}: ${reason} (${n.detail})` : `${what}: ${reason}`
}

// A list the server cut at what it keeps of it (`cut`), as the window says it under the list; '' for one that fits.
export function cutText(cut: InvestigationCut | undefined, tr: Tr): string {
  return cut
    ? tr('investigations.result.partial', 'Showing the first {{shown}} of {{total}}: the server did not keep the rest.', { shown: cut.kept, total: cut.given })
    : ''
}

// The lines above the result: a block the server could not read, the second ask.
export function resultNotes(result: InvestigationResult, tr: Tr): string[] {
  const notes: string[] = []
  if (result.status === 'cut') {
    notes.push(tr('investigations.result.cut', 'The answer reached its length limit inside its result block, so the report has no causes or hypotheses to show.'))
  } else if (result.status !== 'ok') {
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
const NOTE_RULE = '\n\n---\n\n'  // the server's notes under a report each follow this rule
export const CHAT_NOTES = 1024
const CHAT_TEXT = 120
const LEAVE_OUT = ['hypotheses', 'checked_normal', 'not_looked_at', 'ruled_out', 'path'] as const  // in this order while the layer is past 8 KB

const short = (s: string) => (s.length > CHAT_TEXT ? `${s.slice(0, CHAT_TEXT - 1)}…` : s)

// The report's start cut to `limit`, then its last notes from the earliest rule whose rest fits in CHAT_NOTES.
export function reportForChat(report: string, limit: number): string {
  if (report.length <= limit) return report
  for (let at = report.indexOf(NOTE_RULE); at >= 0; at = report.indexOf(NOTE_RULE, at + 1)) {
    const notes = report.slice(at)
    if (notes.length <= CHAT_NOTES) return `${report.slice(0, limit - notes.length - 1)}…${notes}`
  }
  return report.slice(0, limit)
}

const hypothesesForChat = (result: InvestigationResult) => orderedHypotheses(result).map((h) => ({
  statement: short(h.statement),
  resource: short(h.resource),
  state: h.state,
  closed: h.closed,
  for: h.for.map(callLabel),
  against: h.against.map(callLabel),
  ...(h.blocked ? { blocked: short(h.blocked) } : {}),
  ...(h.problems?.length ? { not_closed: h.problems.map((p) => p.reason) } : {}),
  ...(h.cut ? { cut: h.cut } : {}),
}))

// What the floating chat is told of the outcome: the server's, what the report said when it differs, and the server's lists.
const outcomeForChat = (v: InvestigationVerdict) => ({
  outcome: v.outcome,
  ...(v.why.length > 0 ? { outcome_said: v.said, outcome_why: v.why } : {}),
  ...(v.symptom ? { symptom: { resource: short(v.symptom.resource), evidence: v.symptom.evidence.map(callLabel) } } : {}),
  checked_normal: v.checked_normal.map((c) => short(`${checkText(c)} ${callLabel(c)}`)),
  not_looked_at: v.not_looked_at.map((n) => short(`${n.source ?? (n.check ? checkText({ ...n, check: n.check }) : callLabel({ call: n.call ?? 0, tool: n.tool ?? '' }))}: ${n.reason}`)),
  ...(v.cut ? { lists_cut: v.cut } : {}),
})

// What the floating chat is told of the result: a cause the calls do not show says so, hypotheses only with the ledger,
// a list the server cut with how many were given (`cut`).
export function resultForChat(result: InvestigationResult): Record<string, unknown> {
  return {
    status: result.status,
    no_fault: result.no_fault,
    ...(result.verdict ? outcomeForChat(result.verdict) : {}),
    asked_again: result.asked_again,
    causes: result.causes.map((c) => ({
      resource: short(c.resource), kind: c.kind, started_at: c.started_at, evidence: c.evidence.map(callLabel),
      ...(c.verified !== undefined ? { verified: c.verified } : {}),
      ...(c.verified === false && c.reason ? { not_verified: c.reason } : {}),
      ...(c.cut ? { cut: c.cut } : {}),
    })),
    path: result.path.map(short),
    ruled_out: result.ruled_out.map(short),
    ...(ledgerOn(result) ? { hypotheses: hypothesesForChat(result) } : {}),
    ...(result.cut ? { cut: result.cut } : {}),
  }
}

// Past 8 KB: LEAVE_OUT, then the calls' arguments and half the calls, the causes last (enforceTokenBudget halves calls first).
function withinBudget(data: Record<string, unknown>): Record<string, unknown> {
  const result = data.result as Record<string, unknown> | undefined
  const over = () => new Blob([JSON.stringify(data)]).size > MAX_LAYER_BYTES
  const leaveOut = (key: string) => {
    const list = result?.[key]
    if (result && Array.isArray(list)) {
      delete result[key]
      result[`${key}_left_out`] = list.length
    }
  }
  if (!result) return data
  for (const key of LEAVE_OUT) if (over()) leaveOut(key)
  let calls = data.tool_calls as Record<string, unknown>[]
  if (over()) {
    calls = calls.map((call) => Object.fromEntries(Object.entries(call).filter(([key]) => key !== 'args')))
    data.tool_calls = calls
    data.tool_args_left_out = true
  }
  while (over() && calls.length > 1) {
    data.tool_calls = calls = calls.slice(0, Math.ceil(calls.length / 2))
    data.tool_calls_shown = calls.length
  }
  if (over()) leaveOut('causes')
  return data
}

// What the report window tells the floating chat: the report and its calls, and the result when the server kept one.
export function reportLayer(data: Investigation): AIContextInput {
  return {
    source: 'InvestigationModal',
    summary: `알림 조사 보고서 — ${data.alertname} (${data.cluster}${data.namespace ? ` / ${data.namespace}` : ''}, ${data.status})`,
    data: withinBudget({
      alertname: data.alertname, cluster: data.cluster, namespace: data.namespace, severity: data.severity, status: data.status,
      labels: data.labels, received_at: data.received_at, model: data.model, iterations: data.iterations,
      tool_calls: data.tool_calls.map((c) => ({ tool: c.tool, args: c.args, error: c.error })),
      error: data.error || undefined, skip_reason: data.status === 'skipped' ? data.skip_reason || undefined : undefined,
      // with a result the report is cut shorter: the result holds what the report's end would
      ...(data.result ? { result: resultForChat(data.result) } : {}),
      report: data.result ? reportForChat(data.report, CHAT_REPORT_WITH_RESULT) : data.report.slice(0, 4096),
    }),
  }
}
