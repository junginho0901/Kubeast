import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  SummaryBadge,
  KeyValueTags,
  EventsTable,
  fmtRel,
} from './DetailCommon'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

// Parse k8s quantity strings to a numeric value usable for ratios. Returns null
// for unparseable inputs (count-only quotas like "5" are parsed as 5, percentages
// remain meaningful). For CPU keys returns millicores; for memory returns bytes.
function parseQuantity(s: string | undefined | null): number | null {
  if (typeof s !== 'string' || s.length === 0) return null
  if (s.endsWith('m')) {
    const n = parseFloat(s.slice(0, -1))
    return Number.isFinite(n) ? n : null
  }
  const memUnits: Array<[string, number]> = [
    ['Ki', 1024], ['Mi', 1024 ** 2], ['Gi', 1024 ** 3], ['Ti', 1024 ** 4],
    ['Pi', 1024 ** 5], ['Ei', 1024 ** 6],
    ['K', 1000], ['M', 1000 ** 2], ['G', 1000 ** 3], ['T', 1000 ** 4],
  ]
  for (const [u, mult] of memUnits) {
    if (s.endsWith(u)) {
      const n = parseFloat(s.slice(0, -u.length))
      return Number.isFinite(n) ? n * mult : null
    }
  }
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

function computeQuotaPct(used: string | undefined, hard: string | undefined): number | null {
  const u = parseQuantity(used)
  const h = parseQuantity(hard)
  if (u == null || h == null || h === 0) return null
  return Math.round((u / h) * 100)
}

export default function ResourceQuotaInfo({ name, namespace }: Props) {
  const { data: desc, isLoading } = useQuery({
    queryKey: ['resourcequota-describe', namespace, name],
    queryFn: () => api.describeResourceQuota(namespace, name),
    staleTime: 10_000,
    retry: 1,
  })

  useResourceDetailOverlay({ kind: 'ResourceQuota', name, namespace, describe: desc })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center">Loading...</div>
  }

  if (!desc) {
    return <div className="text-xs text-slate-400 py-4 text-center">No data</div>
  }

  const statusHard: Record<string, string> = desc.status_hard || {}
  const statusUsed: Record<string, string> = desc.status_used || {}
  const scopes: string[] = desc.scopes || []
  const scopeSelector: any[] = desc.scope_selector || []
  const events: any[] = desc.events || []
  const resourceKeys = Object.keys(statusHard)

  return (
    <div className="space-y-4">
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Resources" value={resourceKeys.length} color={resourceKeys.length > 0 ? 'green' : 'default'} />
        {scopes.length > 0 && (
          <SummaryBadge label="Scopes" value={scopes.length} color="default" />
        )}
      </div>

      {/* Summary */}
      <InfoSection title="Summary">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Namespace" value={namespace} />
          <InfoRow label="UID" value={desc.uid || '-'} />
          <InfoRow label="Created" value={fmtRel(desc.created_at)} />
        </div>
      </InfoSection>

      {/* Resource Usage */}
      <InfoSection title="Resource Usage">
        {resourceKeys.length === 0 ? (
          <span className="text-slate-400 text-xs">(none)</span>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[480px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[35%]">Resource</th>
                  <th className="text-left py-2 w-[20%]">Used</th>
                  <th className="text-left py-2 w-[20%]">Hard</th>
                  <th className="text-left py-2 w-[25%]">Usage %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {resourceKeys.map((key) => {
                  const used = statusUsed[key]
                  const hard = statusHard[key]
                  const pct = computeQuotaPct(used, hard)
                  const cls = pct == null ? '' : pct > 90 ? 'badge-error' : pct > 70 ? 'badge-warning' : 'badge-success'
                  return (
                    <tr key={key} className="text-slate-200">
                      <td className="py-2 pr-2 font-medium break-all whitespace-normal align-top">{key}</td>
                      <td className="py-2 pr-2 align-top">{used ?? '-'}</td>
                      <td className="py-2 pr-2 align-top">{hard ?? '-'}</td>
                      <td className="py-2 pr-2 align-top">
                        {pct == null ? <span className="text-slate-500">-</span> : <span className={`badge ${cls}`}>{pct}%</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </InfoSection>

      {/* Scopes */}
      {scopes.length > 0 && (
        <InfoSection title="Scopes">
          <div className="flex flex-wrap gap-2 text-xs text-slate-200">
            {scopes.map((scope, idx) => (
              <span key={`${scope}-${idx}`} className="inline-flex items-center rounded-full border border-slate-700 bg-slate-800/80 px-2 py-1">
                {scope}
              </span>
            ))}
          </div>
        </InfoSection>
      )}

      {/* Scope Selector */}
      {scopeSelector.length > 0 && (
        <InfoSection title="Scope Selector">
          <div className="space-y-2">
            {scopeSelector.map((expr: any, idx: number) => (
              <div key={idx} className="text-xs text-slate-200 rounded border border-slate-700 bg-slate-800/80 px-3 py-2">
                <InfoRow label="Scope Name" value={expr.scope_name || expr.scopeName || '-'} />
                <InfoRow label="Operator" value={expr.operator || '-'} />
                {(expr.values || []).length > 0 && (
                  <InfoRow label="Values" value={(expr.values as string[]).join(', ')} />
                )}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {/* Events */}
      <InfoSection title="Events">
        <EventsTable events={events} />
      </InfoSection>

      {/* Labels & Annotations */}
      <InfoSection title="Labels">
        <KeyValueTags data={desc.labels} />
      </InfoSection>

      <InfoSection title="Annotations">
        <KeyValueTags data={desc.annotations} />
      </InfoSection>
    </div>
  )
}
