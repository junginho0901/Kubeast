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

const typeColors: Record<string, 'green' | 'amber' | 'red' | 'default'> = {
  Container: 'green',
  Pod: 'amber',
  PersistentVolumeClaim: 'red',
}

export default function LimitRangeInfo({ name, namespace }: Props) {
  const { data: desc, isLoading } = useQuery({
    queryKey: ['limitrange-describe', namespace, name],
    queryFn: () => api.describeLimitRange(namespace, name),
    staleTime: 10_000,
    retry: 1,
  })

  useResourceDetailOverlay({ kind: 'LimitRange', name, namespace, describe: desc })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center">Loading...</div>
  }

  if (!desc) {
    return <div className="text-xs text-slate-400 py-4 text-center">No data</div>
  }

  const limits: any[] = desc.limits || []
  const events: any[] = desc.events || []
  const uniqueTypes = [...new Set(limits.map((l: any) => l.type).filter(Boolean))]

  return (
    <div className="space-y-4">
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Limit Types" value={limits.length} color="default" />
        {uniqueTypes.map(t => (
          <SummaryBadge key={t} label={t} value="active" color={typeColors[t] || 'default'} />
        ))}
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

      {/* Limits */}
      <InfoSection title="Limits">
        {limits.length > 0 ? (
          <div className="space-y-3">
            {limits.map((lim: any, li: number) => (
              <div key={li} className="rounded border border-slate-800 p-3">
                <p className="text-[11px] text-slate-400 mb-1">Type: {lim.type || '-'}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs table-fixed min-w-[480px]">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="text-left py-1 w-[20%]">Resource</th>
                        <th className="text-left py-1 w-[20%]">Min</th>
                        <th className="text-left py-1 w-[20%]">Max</th>
                        <th className="text-left py-1 w-[20%]">Default</th>
                        <th className="text-left py-1 w-[20%]">Default Request</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {Object.keys({ ...lim.min, ...lim.max, ...lim.default, ...lim.default_request }).map(res => (
                        <tr key={res} className="text-slate-200">
                          <td className="py-1 pr-2 font-mono">{res}</td>
                          <td className="py-1 pr-2">{lim.min?.[res] || '-'}</td>
                          <td className="py-1 pr-2">{lim.max?.[res] || '-'}</td>
                          <td className="py-1 pr-2">{lim.default?.[res] || '-'}</td>
                          <td className="py-1 pr-2">{lim.default_request?.[res] || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        ) : <span className="text-slate-400 text-xs">(none)</span>}
      </InfoSection>

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
