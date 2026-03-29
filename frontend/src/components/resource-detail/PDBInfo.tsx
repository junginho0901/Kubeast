import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  InfoGrid,
  SummaryBadge,
  KeyValueTags,
  ConditionsTable,
  EventsTable,
  fmtRel,
} from './DetailCommon'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function PDBInfo({ name, namespace }: Props) {
  const { data: desc, isLoading } = useQuery({
    queryKey: ['pdb-describe', namespace, name],
    queryFn: () => api.describePDB(namespace, name),
    staleTime: 10_000,
    retry: 1,
  })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center">Loading...</div>
  }

  if (!desc) {
    return <div className="text-xs text-slate-400 py-4 text-center">No data</div>
  }

  const minAvailable = desc.min_available ?? '-'
  const maxUnavailable = desc.max_unavailable ?? '-'
  const currentHealthy = desc.current_healthy ?? 0
  const desiredHealthy = desc.desired_healthy ?? 0
  const disruptionsAllowed = desc.disruptions_allowed ?? 0
  const expectedPods = desc.expected_pods ?? 0

  const selector: Record<string, string> = desc.selector || {}
  const matchExpressions: any[] = desc.match_expressions || []
  const conditions: any[] = desc.conditions || []
  const events: any[] = desc.events || []
  const unhealthyPodEvictionPolicy = desc.unhealthy_pod_eviction_policy || null

  const isHealthy = disruptionsAllowed > 0 || currentHealthy >= desiredHealthy

  return (
    <div className="space-y-4">
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Current Healthy" value={currentHealthy} color={isHealthy ? 'green' : 'red'} />
        <SummaryBadge label="Desired Healthy" value={desiredHealthy} color="default" />
        <SummaryBadge label="Disruptions Allowed" value={disruptionsAllowed} color={disruptionsAllowed > 0 ? 'green' : 'amber'} />
        <SummaryBadge label="Expected Pods" value={expectedPods} color="default" />
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

      {/* Disruption Budget */}
      <InfoSection title="Disruption Budget">
        <InfoGrid>
          <InfoRow label="Min Available" value={minAvailable} />
          <InfoRow label="Max Unavailable" value={maxUnavailable} />
          {unhealthyPodEvictionPolicy && (
            <InfoRow label="Unhealthy Pod Eviction Policy" value={unhealthyPodEvictionPolicy} />
          )}
        </InfoGrid>
      </InfoSection>

      {/* Status */}
      <InfoSection title="Status">
        <InfoGrid>
          <InfoRow label="Current Healthy" value={currentHealthy} />
          <InfoRow label="Desired Healthy" value={desiredHealthy} />
          <InfoRow label="Disruptions Allowed" value={disruptionsAllowed} />
          <InfoRow label="Expected Pods" value={expectedPods} />
        </InfoGrid>
      </InfoSection>

      {/* Selector */}
      <InfoSection title="Selector">
        {Object.keys(selector).length > 0 ? (
          <KeyValueTags data={selector} />
        ) : (
          <div className="text-xs text-slate-400">-</div>
        )}
      </InfoSection>

      {/* Match Expressions */}
      {matchExpressions.length > 0 && (
        <InfoSection title="Match Expressions">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[30%]">Key</th>
                  <th className="text-left py-2 w-[20%]">Operator</th>
                  <th className="text-left py-2 w-[50%]">Values</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {matchExpressions.map((expr: any, idx: number) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-2 pr-2 break-all whitespace-normal">{expr.key || '-'}</td>
                    <td className="py-2 pr-2">{expr.operator || '-'}</td>
                    <td className="py-2 pr-2 break-all whitespace-normal">
                      {Array.isArray(expr.values) ? expr.values.join(', ') : '-'}
                    </td>
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
