import { useTranslation } from 'react-i18next'
import { FileSearch } from 'lucide-react'

import type { PastInvestigation } from '@/services/api/alertInbox'
import { outcomeBadge, outcomeText } from '@/utils/investigationResult'
import { formatTime, utcTitle } from '@/utils/time'

// The same alert's earlier investigations in its window (features.alertInvestigation.pastReports.window; the server
// leaves the list out with the switch off). What a model wrote is drawn as plain text; a report opens through `onOpen`,
// whose read is audited server-side. null: the server could not read them.
export function PastInvestigations({ items, onOpen }: { items: PastInvestigation[] | null; onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  return (
    <section data-testid="alert-past-section">
      <h3 className="mb-1 text-xs font-semibold text-slate-400">{tr('alertInbox.past.title', 'Past investigations of this alert')}</h3>
      <p className="mb-2 text-xs text-slate-500">
        {tr('alertInbox.past.note', 'Up to five of the last 30 days, newest first: what the AI concluded then, confirmed by no person. This time the cause may be another.')}
      </p>
      {items === null ? (
        <p className="text-xs text-amber-300" data-testid="alert-past-failed">{tr('alertInbox.past.failed', 'The past investigations could not be read.')}</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-slate-500" data-testid="alert-past-none">{tr('common.none', 'None')}</p>
      ) : (
        <ul className="space-y-2 text-xs" data-testid="alert-past-list" data-list-bounded="an alert's past investigations, at most five">
          {items.map((p) => (
            <li key={p.id} className="flex items-start gap-3" data-testid={`alert-past-${p.id}`}>
              <span className="shrink-0 whitespace-nowrap text-slate-300" title={utcTitle(p.received_at)}>{formatTime(p.received_at)}</span>
              {p.outcome
                ? <span className={`shrink-0 ${outcomeBadge[p.outcome] ?? 'badge badge-neutral'}`} data-outcome={p.outcome}>{outcomeText(p.outcome, tr)}</span>
                : <span className="shrink-0 text-slate-500">-</span>}
              <span className="min-w-0 flex-1 space-y-0.5">
                {p.causes.map((c, i) => (
                  <span key={i} className="block break-all" data-testid="alert-past-cause">
                    <span className="font-mono text-ink">{c.resource || '-'}</span>
                    {c.kind && <span className="ml-2 text-slate-400">{c.kind}</span>}
                    {c.verified === true && <span className="ml-2 text-slate-400">{tr('alertInbox.past.checked', 'Checked by the server')}</span>}
                    {c.verified === false && <span className="ml-2 text-amber-300">{tr('investigations.result.notVerifiedBare', 'Not verified')}</span>}
                  </span>
                ))}
                {p.causes_total > p.causes.length && (
                  <span className="block text-slate-400">{tr('alertInbox.past.more', '+{{n}} more', { n: p.causes_total - p.causes.length })}</span>
                )}
                {/* a result the server read that names no cause; with no result the outcome's - says it */}
                {p.outcome && p.causes_total === 0 && <span className="block text-notice-text-muted" data-testid="alert-past-no-causes">{tr('common.none', 'None')}</span>}
              </span>
              <button type="button" onClick={() => onOpen(p.id)} className="btn-row inline-flex shrink-0 items-center gap-1" data-testid="alert-past-report">
                <FileSearch className="w-3.5 h-3.5" /> {tr('investigations.open', 'Report')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
