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
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[40%]">Resource</th>
                  <th className="text-left py-2 w-[30%]">Used</th>
                  <th className="text-left py-2 w-[30%]">Hard</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {resourceKeys.map((key) => (
                  <tr key={key} className="text-slate-200">
                    <td className="py-2 pr-2 font-medium break-all whitespace-normal align-top">{key}</td>
                    <td className="py-2 pr-2 align-top">{statusUsed[key] ?? '-'}</td>
                    <td className="py-2 pr-2 align-top">{statusHard[key] ?? '-'}</td>
                  </tr>
                ))}
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
