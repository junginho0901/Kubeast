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
import { ResourceLink } from './ResourceLink'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function HPAInfo({ name, namespace }: Props) {
  const { data: desc, isLoading } = useQuery({
    queryKey: ['hpa-describe', namespace, name],
    queryFn: () => api.describeHPA(namespace, name),
    staleTime: 10_000,
    retry: 1,
  })

  useResourceDetailOverlay({ kind: 'HorizontalPodAutoscaler', name, namespace, describe: desc })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center">Loading...</div>
  }

  if (!desc) {
    return <div className="text-xs text-slate-400 py-4 text-center">No data</div>
  }

  const scaleTargetRef = desc.scale_target_ref || {}
  const minReplicas = desc.min_replicas ?? '-'
  const maxReplicas = desc.max_replicas ?? '-'
  const currentReplicas = desc.current_replicas ?? 0
  const desiredReplicas = desc.desired_replicas ?? 0

  const metricsSpec: any[] = desc.metrics_spec || []
  const metricsStatus: any[] = desc.metrics_status || []
  const conditions: any[] = desc.conditions || []
  const events: any[] = desc.events || []
  const behavior = desc.behavior || null

  return (
    <div className="space-y-4">
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Current" value={currentReplicas} color={currentReplicas > 0 ? 'green' : 'default'} />
        <SummaryBadge label="Desired" value={desiredReplicas} color="default" />
        <SummaryBadge label="Min" value={minReplicas} color="default" />
        <SummaryBadge label="Max" value={maxReplicas} color="default" />
      </div>

      {/* Basic Info */}
      <InfoSection title="Summary">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Namespace" value={namespace} />
          <InfoRow label="UID" value={desc.uid || '-'} />
          <InfoRow label="Created" value={fmtRel(desc.created_at)} />
          {desc.last_scale_time && (
            <InfoRow label="Last Scale Time" value={fmtRel(desc.last_scale_time)} />
          )}
        </div>
      </InfoSection>

      {/* Scale Target */}
      <InfoSection title="Scale Target Reference">
        <div className="space-y-2">
          <InfoRow label="Kind" value={scaleTargetRef.kind || '-'} />
          <InfoRow label="Name" value={scaleTargetRef.name ? <ResourceLink kind={scaleTargetRef.kind || 'Deployment'} name={scaleTargetRef.name} namespace={namespace} /> : '-'} />
          <InfoRow label="API Version" value={scaleTargetRef.api_version || '-'} />
        </div>
      </InfoSection>

      {/* Replicas */}
      <InfoSection title="Replicas">
        <InfoGrid>
          <InfoRow label="Min Replicas" value={minReplicas} />
          <InfoRow label="Max Replicas" value={maxReplicas} />
          <InfoRow label="Current Replicas" value={currentReplicas} />
          <InfoRow label="Desired Replicas" value={desiredReplicas} />
        </InfoGrid>
      </InfoSection>

      {/* Metrics */}
      {metricsSpec.length > 0 && (
        <InfoSection title="Metrics">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[600px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[20%]">Type</th>
                  <th className="text-left py-2 w-[25%]">Resource / Name</th>
                  <th className="text-left py-2 w-[25%]">Target</th>
                  <th className="text-left py-2 w-[30%]">Current</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {metricsSpec.map((m: any, idx: number) => {
                  const status = metricsStatus[idx] || m.current || {}
                  const targetStr = formatMetricTarget(m)
                  const currentStr = formatMetricCurrent(status)

                  return (
                    <tr key={idx} className="text-slate-200">
                      <td className="py-2 pr-2 align-top">{m.type || '-'}</td>
                      <td className="py-2 pr-2 align-top break-all whitespace-normal">
                        {m.resource_name || m.metric_name || '-'}
                        {m.container && <span className="text-slate-400 ml-1">({m.container})</span>}
                      </td>
                      <td className="py-2 pr-2 align-top break-all whitespace-normal">{targetStr}</td>
                      <td className="py-2 pr-2 align-top break-all whitespace-normal">{currentStr}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {/* Behavior */}
      {behavior && (
        <InfoSection title="Behavior">
          <div className="space-y-3">
            {behavior.scale_up && (
              <div>
                <p className="text-xs text-slate-400 mb-1">Scale Up</p>
                <div className="space-y-1">
                  {behavior.scale_up.stabilization_window_seconds != null && (
                    <InfoRow label="Stabilization Window" value={`${behavior.scale_up.stabilization_window_seconds}s`} />
                  )}
                  {behavior.scale_up.select_policy && (
                    <InfoRow label="Select Policy" value={behavior.scale_up.select_policy} />
                  )}
                  {Array.isArray(behavior.scale_up.policies) && behavior.scale_up.policies.map((p: any, i: number) => (
                    <InfoRow key={i} label={`Policy ${i + 1}`} value={`${p.type}: ${p.value} / ${p.period_seconds}s`} />
                  ))}
                </div>
              </div>
            )}
            {behavior.scale_down && (
              <div>
                <p className="text-xs text-slate-400 mb-1">Scale Down</p>
                <div className="space-y-1">
                  {behavior.scale_down.stabilization_window_seconds != null && (
                    <InfoRow label="Stabilization Window" value={`${behavior.scale_down.stabilization_window_seconds}s`} />
                  )}
                  {behavior.scale_down.select_policy && (
                    <InfoRow label="Select Policy" value={behavior.scale_down.select_policy} />
                  )}
                  {Array.isArray(behavior.scale_down.policies) && behavior.scale_down.policies.map((p: any, i: number) => (
                    <InfoRow key={i} label={`Policy ${i + 1}`} value={`${p.type}: ${p.value} / ${p.period_seconds}s`} />
                  ))}
                </div>
              </div>
            )}
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

function formatMetricTarget(m: any): string {
  if (m.target_average_utilization != null) return `${m.target_average_utilization}% (Utilization)`
  if (m.target_average_value) return `${m.target_average_value} (Avg)`
  if (m.target_value) return `${m.target_value}`
  return '-'
}

function formatMetricCurrent(s: any): string {
  if (s.current_average_utilization != null) return `${s.current_average_utilization}%`
  if (s.current_average_value) return `${s.current_average_value}`
  if (s.current_value) return `${s.current_value}`
  return '-'
}
