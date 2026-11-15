import { useTranslation } from 'react-i18next'

import type { InvestigationCallRef, InvestigationResult, InvestigationToolCall } from '@/services/api/investigations'
import { formatTime } from '@/utils/time'
import { callLabel, ledgerOn, notClosedText, notVerifiedText, orderedHypotheses, resultNotes, stateBadge, stateText } from '@/utils/investigationResult'

// The report's result and hypothesis ledger, under the report in its window (features.alertInvestigation.evidenceCheck
// or ledger). Every text here came from a model that read an external alert, so it is drawn as plain text: no
// Markdown, no HTML. A call number names a row of the window's tool calls, whose arguments show on hover. A cause the
// calls do not show says so; the hypotheses show only when the ledger read the block.

function Calls({ refs, toolCalls }: { refs: InvestigationCallRef[]; toolCalls: InvestigationToolCall[] }) {
  const { t } = useTranslation()
  if (refs.length === 0) return <span className="text-slate-500">-</span>
  return (
    <span className="flex flex-wrap gap-1">
      {refs.map((r) => (
        <span
          key={r.call}
          className={`rounded-sm border px-1.5 py-0.5 font-mono ${r.failed ? 'border-red-800/60 text-red-300' : 'border-slate-700 text-slate-300'}`}
          title={JSON.stringify(toolCalls[r.call - 1]?.args ?? {}) + (r.failed ? ` (${t('investigations.tool.error', { defaultValue: 'refused' })})` : '')}
          data-testid="investigation-result-call"
        >
          {callLabel(r)}
        </span>
      ))}
    </span>
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
      <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-950/40 px-4 py-3 text-xs">
        {notes.map((n) => (
          <div key={n} className={result.status === 'ok' ? 'text-slate-400' : 'text-amber-300'} data-testid="investigation-result-note">{n}</div>
        ))}
        {result.status === 'ok' && (
          <>
            {result.no_fault === true && (
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
                      {c.verified === false && (
                        <span className="badge badge-warning" data-testid="investigation-cause-unverified">{notVerifiedText(c, tr)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.path.length > 0 && (
              <div>
                <div className="mb-1 font-semibold text-slate-400">{tr('investigations.result.path', 'Path (cause → symptom)')}</div>
                <div className="font-mono text-ink break-all" data-testid="investigation-result-path">{result.path.join(' → ')}</div>
              </div>
            )}
            {result.ruled_out.length > 0 && (
              <div>
                <div className="mb-1 font-semibold text-slate-400">{tr('investigations.result.ruledOut', 'Ruled out')}</div>
                <div className="font-mono text-ink break-all" data-testid="investigation-result-ruled-out">{result.ruled_out.join(', ')}</div>
              </div>
            )}
            {withLedger && <div>
              <div className="mb-1 font-semibold text-slate-400">
                {tr('investigations.result.hypotheses', 'Hypotheses ({{count}})', { count: hypotheses.length })}
              </div>
              {hypotheses.length === 0 ? (
                <div className="text-slate-500">{tr('common.none', 'None')}</div>
              ) : (
                <table className="w-full" data-testid="investigation-hypotheses" data-list-bounded="the hypotheses of one report, at most 12">
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
                      <tr key={`${h.id}-${i}`} className="border-t border-slate-800 align-top" data-state={h.state}>
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
                        <td className="px-2 py-1"><Calls refs={h.for} toolCalls={toolCalls} /></td>
                        <td className="px-2 py-1"><Calls refs={h.against} toolCalls={toolCalls} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>}
          </>
        )}
      </div>
    </section>
  )
}
