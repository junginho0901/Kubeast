import { useTranslation } from 'react-i18next'

import type { InvestigationCallRef, InvestigationResult, InvestigationToolCall, InvestigationVerdict } from '@/services/api/investigations'
import { formatTime } from '@/utils/time'
import {
  callLabel, checkText, cutText, ledgerOn, notClosedText, notLookedAtText, notVerifiedText, orderedHypotheses, outcomeBadge, outcomeText,
  outcomeWhyText, resultNotes, sourceText, stateBadge, stateText,
} from '@/utils/investigationResult'

// The report's result (evidenceCheck or ledger) under the report: model text drawn as plain text, calls by their number.

function Calls({ refs, toolCalls }: { refs: InvestigationCallRef[]; toolCalls: InvestigationToolCall[] }) {
  const { t } = useTranslation()
  if (refs.length === 0) return <span className="text-slate-500">-</span>
  return (
    <span className="flex flex-wrap gap-1">
      {refs.map((r) => (
        <span
          key={r.call}
          className={`rounded-sm border px-1.5 py-0.5 font-mono ${r.failed ? 'border-red-800/60 text-red-300' : 'border-hairline text-slate-300'}`}
          title={JSON.stringify(toolCalls[r.call - 1]?.args ?? {}) + (r.failed ? ` (${t('investigations.tool.error', { defaultValue: 'refused' })})` : '')}
          data-testid="investigation-result-call"
        >
          {callLabel(r)}
        </span>
      ))}
    </span>
  )
}

// Under a list the server cut at what it keeps of it: the first how many of how many it shows (cutText).
function CutNote({ text, testId = 'investigation-result-cut' }: { text: string; testId?: string }) {
  return text ? <div className="mt-1 text-amber-300" data-testid={testId}>{text}</div> : null
}

// The outcome the server keeps and its lists, made from the run's calls.
function Outcome({ verdict, toolCalls }: { verdict: InvestigationVerdict; toolCalls: InvestigationToolCall[] }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const why = outcomeWhyText(verdict, tr)
  return (
    <div className="space-y-3" data-testid="investigation-outcome">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-slate-400">{tr('investigations.result.outcomeTitle', 'Outcome')}</span>
        {verdict.outcome
          ? <span className={outcomeBadge[verdict.outcome] ?? 'badge badge-neutral'} data-outcome={verdict.outcome}>{outcomeText(verdict.outcome, tr)}</span>
          : <span className="text-slate-500">-</span>}
        {why && <span className="text-amber-300 break-words" data-testid="investigation-outcome-why">{why}</span>}
      </div>
      {verdict.symptom && (
        <div className="flex flex-wrap items-center gap-2" data-testid="investigation-outcome-symptom">
          <span className="font-semibold text-slate-400">{tr('investigations.result.symptom', 'Symptom shown in')}</span>
          <span className="font-mono text-ink break-all">{verdict.symptom.resource || '-'}</span>
          <Calls refs={verdict.symptom.evidence} toolCalls={toolCalls} />
          <CutNote text={cutText(verdict.symptom.cut?.evidence, tr)} />
        </div>
      )}
      <div>
        <div className="mb-1 font-semibold text-slate-400">{tr('investigations.result.lookedAt', 'Looked at')}</div>
        {verdict.looked_at.length === 0 ? <div className="text-slate-500">{tr('common.none', 'None')}</div> : (
          <ul className="space-y-1" data-testid="investigation-looked-at">
            {verdict.looked_at.map((l) => (
              <li key={l.source} className="flex flex-wrap items-center gap-2">
                <span className="text-ink">{sourceText(l.source, tr)}</span>
                <Calls refs={l.calls} toolCalls={toolCalls} />
                <CutNote text={cutText(l.cut?.calls, tr)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="mb-1 font-semibold text-slate-400">{tr('investigations.result.checkedNormal', 'Checked and normal')}</div>
        {verdict.checked_normal.length === 0 ? <div className="text-slate-500">{tr('common.none', 'None')}</div> : (
          <ul className="space-y-1" data-testid="investigation-checked-normal">
            {verdict.checked_normal.map((c, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-ink break-all">{checkText(c)}</span>
                {c.since && c.until && <span className="text-slate-400">{`${formatTime(c.since)} – ${formatTime(c.until)}`}</span>}
                <Calls refs={[{ call: c.call, tool: c.tool }]} toolCalls={toolCalls} />
                {c.partial && <span className="text-amber-300 break-words">{tr('investigations.result.partialCheck', 'read in part: {{reason}}', { reason: c.partial })}</span>}
              </li>
            ))}
          </ul>
        )}
        <CutNote text={cutText(verdict.cut?.checked_normal, tr)} />
      </div>
      <div>
        <div className="mb-1 font-semibold text-slate-400">{tr('investigations.result.notLookedAt', 'Not looked at')}</div>
        {verdict.not_looked_at.length === 0 ? <div className="text-slate-500">{tr('common.none', 'None')}</div> : (
          <ul className="space-y-1 text-ink" data-testid="investigation-not-looked-at">
            {verdict.not_looked_at.map((n, i) => <li key={i} className="break-words">{notLookedAtText(n, tr)}</li>)}
          </ul>
        )}
        <CutNote text={cutText(verdict.cut?.not_looked_at, tr)} />
      </div>
    </div>
  )
}

export function InvestigationResultView({ result, toolCalls }: { result: InvestigationResult; toolCalls: InvestigationToolCall[] }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const notes = resultNotes(result, tr)
  const hypotheses = orderedHypotheses(result)
  const withLedger = ledgerOn(result)

  return (
    <section data-testid="investigation-result">
      <h3 className="mb-2 text-xs font-semibold text-slate-400">
        {withLedger ? tr('investigations.result.title', 'Result and hypotheses') : tr('investigations.result.titleCauses', 'Result')}
      </h3>
      <div className="min-w-0 space-y-3 border-t border-hairline pt-3 text-xs">
        {notes.map((n) => (
          <div key={n} className={result.status === 'ok' ? 'text-slate-400' : 'text-amber-300'} data-testid="investigation-result-note">{n}</div>
        ))}
        {result.verdict && <Outcome verdict={result.verdict} toolCalls={toolCalls} />}
        {result.status === 'ok' && (
          <>
            {result.no_fault === true && !result.verdict && (
              <div className="text-ink" data-testid="investigation-result-nofault">{tr('investigations.result.noFault', 'The report finds no fault.')}</div>
            )}
            {result.causes.length > 0 && (
              <div>
                <div className="mb-1 font-semibold text-slate-400">{tr('investigations.result.causes', 'Causes')}</div>
                <ul className="space-y-1" data-testid="investigation-result-causes">
                  {result.causes.map((c, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-ink break-all">{c.resource || '-'}</span>
                      {c.kind && <span className="text-slate-400">{c.kind}</span>}
                      {c.started_at && <span className="text-slate-400">{tr('investigations.result.started', 'from {{at}}', { at: formatTime(c.started_at) })}</span>}
                      <Calls refs={c.evidence} toolCalls={toolCalls} />
                      {c.cut?.evidence && (
                        <span className="text-amber-300" data-testid="investigation-cause-calls-cut">{cutText(c.cut.evidence, tr)}</span>
                      )}
                      {c.verified === false && (
                        <span className="badge badge-warning" data-testid="investigation-cause-unverified">{notVerifiedText(c, tr)}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <CutNote text={cutText(result.cut?.causes, tr)} />
              </div>
            )}
            {result.path.length > 0 && (
              <div>
                <div className="mb-1 font-semibold text-slate-400">{tr('investigations.result.path', 'Path (cause → symptom)')}</div>
                <div className="font-mono text-ink break-all" data-testid="investigation-result-path">{result.path.join(' → ')}</div>
                <CutNote text={cutText(result.cut?.path, tr)} />
              </div>
            )}
            {result.ruled_out.length > 0 && (
              <div>
                <div className="mb-1 font-semibold text-slate-400">{tr('investigations.result.ruledOut', 'Ruled out')}</div>
                <div className="font-mono text-ink break-all" data-testid="investigation-result-ruled-out">{result.ruled_out.join(', ')}</div>
                <CutNote text={cutText(result.cut?.ruled_out, tr)} />
              </div>
            )}
            {withLedger && <div>
              <div className="mb-1 font-semibold text-slate-400">
                {tr('investigations.result.hypotheses', 'Hypotheses ({{count}})', { count: hypotheses.length })}
              </div>
              {hypotheses.length === 0 ? (
                <div className="text-slate-500">{tr('common.none', 'None')}</div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem]" data-testid="investigation-hypotheses" data-list-bounded="the hypotheses of one report, at most 12">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="px-2 py-1 text-left">{tr('investigations.result.col.hypothesis', 'Hypothesis')}</th>
                      <th className="px-2 py-1 text-left">{tr('investigations.result.col.state', 'State')}</th>
                      <th className="px-2 py-1 text-left">{tr('investigations.result.col.for', 'For')}</th>
                      <th className="px-2 py-1 text-left">{tr('investigations.result.col.against', 'Against')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hypotheses.map((h, i) => (
                      <tr key={`${h.id}-${i}`} className="border-t border-hairline align-top" data-state={h.state}>
                        <td className="px-2 py-1">
                          <div className="text-ink break-words">{h.statement || '-'}</div>
                          {h.resource && <div className="font-mono text-slate-400 break-all">{h.resource}</div>}
                        </td>
                        <td className="px-2 py-1">
                          <span className={stateBadge[h.state] ?? 'badge badge-neutral'}>{stateText(h.state, tr)}</span>
                          {h.blocked && (
                            <div className="mt-1 text-slate-400 break-words">{tr('investigations.result.blockedBecause', 'Blocked: {{reason}}', { reason: h.blocked })}</div>
                          )}
                          {!h.closed && <div className="mt-1 text-amber-300 break-words" data-testid="investigation-hypothesis-open">{notClosedText(h, tr)}</div>}
                        </td>
                        <td className="px-2 py-1">
                          <Calls refs={h.for} toolCalls={toolCalls} />
                          <CutNote text={cutText(h.cut?.for, tr)} testId="investigation-hypothesis-calls-cut" />
                        </td>
                        <td className="px-2 py-1">
                          <Calls refs={h.against} toolCalls={toolCalls} />
                          <CutNote text={cutText(h.cut?.against, tr)} testId="investigation-hypothesis-calls-cut" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
              <CutNote text={cutText(result.cut?.hypotheses, tr)} />
            </div>}
          </>
        )}
      </div>
    </section>
  )
}
