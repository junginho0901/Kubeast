import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  SummaryBadge,
  KeyValueTags,
  ConditionsTable,
  EventsTable,
  fmtRel,
} from './DetailCommon'
import { ResourceLink } from './ResourceLink'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function VPAInfo({ name, namespace }: Props) {
  const { data: desc, isLoading } = useQuery({
    queryKey: ['vpa-describe', namespace, name],
    queryFn: () => api.describeVPA(namespace, name),
    staleTime: 10_000,
    retry: 1,
  })

  useResourceDetailOverlay({ kind: 'VerticalPodAutoscaler', name, namespace, describe: desc })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center">Loading...</div>
  }

  if (!desc) {
    return <div className="text-xs text-slate-400 py-4 text-center">No data</div>
  }

  const containerPolicies: any[] = desc.container_policies || []
  const conditions: any[] = desc.conditions || []
  const recommendations: any[] = desc.recommendations || []
  const events: any[] = desc.events || []

  return (
    <div className="space-y-4">
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Mode" value={desc.update_mode || '-'} color="default" />
        <SummaryBadge
          label="Provided"
          value={desc.provided || '-'}
          color={desc.provided === 'True' ? 'green' : 'amber'}
        />
        {desc.cpu_target && <SummaryBadge label="CPU" value={desc.cpu_target} color="default" />}
        {desc.memory_target && <SummaryBadge label="Memory" value={desc.memory_target} color="default" />}
      </div>

      {/* Basic Info */}
      <InfoSection title="Summary">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Namespace" value={namespace} />
          <InfoRow label="UID" value={desc.uid || '-'} />
          <InfoRow label="Created" value={fmtRel(desc.created_at)} />
        </div>
      </InfoSection>

      {/* Target Reference */}
      <InfoSection title="Target Reference">
        <div className="space-y-2">
          <InfoRow label="Kind" value={desc.target_ref_kind || '-'} />
          <InfoRow label="Name" value={desc.target_ref_name ? <ResourceLink kind={desc.target_ref_kind || 'Deployment'} name={desc.target_ref_name} namespace={namespace} /> : '-'} />
        </div>
      </InfoSection>

      {/* Update Policy */}
      <InfoSection title="Update Policy">
        <InfoRow label="Update Mode" value={desc.update_mode || '-'} />
      </InfoSection>

      {/* Container Policies */}
      {containerPolicies.length > 0 && (
        <InfoSection title="Container Policies">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[600px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[20%]">Container</th>
                  <th className="text-left py-2 w-[15%]">Mode</th>
                  <th className="text-left py-2 w-[20%]">Controlled</th>
                  <th className="text-left py-2 w-[22%]">Min Allowed</th>
                  <th className="text-left py-2 w-[23%]">Max Allowed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {containerPolicies.map((cp: any, idx: number) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">{cp.container_name || '*'}</td>
                    <td className="py-2 pr-2 align-top">{cp.mode || '-'}</td>
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">
                      {Array.isArray(cp.controlled_resources) ? cp.controlled_resources.join(', ') : cp.controlled_values || '-'}
                    </td>
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">
                      {formatResourceMap(cp.min_allowed)}
                    </td>
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">
                      {formatResourceMap(cp.max_allowed)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <InfoSection title="Recommendations">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[700px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[18%]">Container</th>
                  <th className="text-left py-2 w-[18%]">Lower Bound</th>
                  <th className="text-left py-2 w-[18%]">Target</th>
                  <th className="text-left py-2 w-[18%]">Upper Bound</th>
                  <th className="text-left py-2 w-[28%]">Uncapped Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {recommendations.map((rec: any, idx: number) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">{rec.container_name || '-'}</td>
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">{formatResourceMap(rec.lower_bound)}</td>
                    <td className="py-2 pr-2 align-top break-all whitespace-normal font-medium">{formatResourceMap(rec.target)}</td>
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">{formatResourceMap(rec.upper_bound)}</td>
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">{formatResourceMap(rec.uncapped_target)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {/* Conditions */}
      <InfoSection title="Conditions">
        <ConditionsTable conditions={conditions} />
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

function formatResourceMap(m: any): string {
  if (!m || typeof m !== 'object') return '-'
  const entries = Object.entries(m)
  if (entries.length === 0) return '-'
  return entries.map(([k, v]) => `${k}: ${v}`).join(', ')
}
