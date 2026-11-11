import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, SummaryBadge, KeyValueTags, ConditionsTable, EventsSection, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { ResourceLink } from './ResourceLink'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { VPA_POLICY_EXTRA_HEAD, vpaEvictionText, vpaPolicyExtraRows, vpaRecommendersText, vpaStartupBoostText, vpaValue } from './vpaDetail'
import { DescribeFailure } from './DescribeFailure'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function VPAInfo({ name, namespace }: Props) {
  const { data: desc, isLoading, error: describeError } = useQuery({
    queryKey: ['vpa-describe', namespace, name],
    queryFn: () => api.describeVPA(namespace, name),
    staleTime: 10_000,
    retry: 1,
  })

  useResourceDetailOverlay({ kind: 'VerticalPodAutoscaler', name, namespace, describe: desc })

  // Inline target controller status — saves a click vs ResourceLink navigate.
  // Supports Deployment / StatefulSet / DaemonSet / ReplicaSet. Other kinds
  // (custom controllers) fall back to ResourceLink only.
  const targetKind = desc?.target_ref_kind as string | undefined
  const targetName = desc?.target_ref_name as string | undefined
  const targetDescribeFn = (() => {
    if (!targetKind || !targetName) return null
    switch (targetKind) {
      case 'Deployment': return () => api.describeDeployment(namespace, targetName)
      case 'StatefulSet': return () => api.describeStatefulSet(namespace, targetName)
      case 'DaemonSet': return () => api.describeDaemonSet(namespace, targetName)
      case 'ReplicaSet': return () => api.describeReplicaSet(namespace, targetName)
      default: return null
    }
  })()
  const { data: targetDescribe, error: targetError } = useQuery({
    queryKey: ['vpa-target', namespace, targetKind, targetName],
    queryFn: targetDescribeFn!,
    enabled: !!targetDescribeFn,
    staleTime: 30_000,
    retry: false,
  })
  const targetStatus = targetDescribe ? {
    desired: (targetDescribe as any)?.replicas ?? (targetDescribe as any)?.desired ?? '-',
    ready: (targetDescribe as any)?.ready_replicas ?? (targetDescribe as any)?.ready ?? '-',
    available: (targetDescribe as any)?.available_replicas ?? (targetDescribe as any)?.available ?? '-',
  } : null

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center"><Tx>Loading...</Tx></div>
  }

  if (!desc) {
    // a read that failed is not an object with no data
    if (describeError) return <DescribeFailure error={describeError} className="py-4" />
    return <div className="text-xs text-slate-400 py-4 text-center"><Tx>No data</Tx></div>
  }

  const containerPolicies: any[] = desc.container_policies || []
  const conditions: any[] = desc.conditions || []
  const recommendations: any[] = desc.recommendations || []
  const policyExtras = vpaPolicyExtraRows(containerPolicies)

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
        <SummaryBadge label="CPU" value={desc.cpu_target || '-'} color="default" />
        <SummaryBadge label="Memory" value={desc.memory_target || '-'} color="default" />
      </div>

      {/* Basic Info */}
      <InfoSection title="Summary">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Namespace" value={namespace} />
          <InfoRow label="UID" value={desc.uid || '-'} />
          <InfoRow label="Created" value={fmtTs(desc.created_at) === '-' ? '-' : `${fmtTs(desc.created_at)} (${fmtRel(desc.created_at)})`} />
          <InfoRow label="Observed Generation" value={vpaValue(desc.observed_generation)} />
        </div>
      </InfoSection>

      {/* Target Reference */}
      <InfoSection title="Target Reference">
        <div className="space-y-2">
          <InfoRow label="Kind" value={desc.target_ref_kind || '-'} />
          <InfoRow label="Name" value={desc.target_ref_name ? <ResourceLink kind={desc.target_ref_kind || 'Deployment'} name={desc.target_ref_name} namespace={namespace} apiVersion={desc.target_ref_api_version} /> : '-'} />
          {targetStatus && (
            <InfoRow
              label="Target Status"
              value={
                <span className="font-mono">
                  <Tx
                    text="Desired: {{desired}} · Ready: {{ready}} · Available: {{available}}"
                    values={{ desired: String(targetStatus.desired), ready: String(targetStatus.ready), available: String(targetStatus.available) }}
                  />
                </span>
              }
            />
          )}
          {/* the target's read failed: its status is not known, not left out */}
          {!targetStatus && targetError && (
            <InfoRow label="Target Status" value={<DescribeFailure error={targetError} />} />
          )}
        </div>
      </InfoSection>

      {/* Update Policy */}
      <InfoSection title="Update Policy">
        <div className="space-y-2">
          <InfoRow label="Update Mode" value={desc.update_mode || '-'} />
          {/* the CRD's wide columns MinReplicas and OOMSeconds, and the pod's startupBoost (VPA 1.7) */}
          <InfoRow label="Min Replicas" value={vpaValue(desc.min_replicas)} />
          <InfoRow label="Evict After OOM Seconds" value={vpaValue(desc.evict_after_oom_seconds)} />
          <InfoRow label="Startup Boost" value={vpaStartupBoostText(desc.startup_boost)} />
          <InfoRow label="Eviction Requirements" value={vpaEvictionText(desc.eviction_requirements)} />
          <InfoRow label="Recommenders" value={vpaRecommendersText(desc.recommenders)} />
        </div>
      </InfoSection>

      {/* Container Policies */}
      {containerPolicies.length > 0 && (
        <InfoSection title="Container Policies">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[700px]">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-2 w-[17%]">Container</Th>
                  <Th className="text-left py-2 w-[11%]">Mode</Th>
                  <Th className="text-left py-2 w-[17%]">Controlled Resources</Th>
                  <Th className="text-left py-2 w-[17%]">Controlled Values</Th>
                  <Th className="text-left py-2 w-[19%]">Min Allowed</Th>
                  <Th className="text-left py-2 w-[19%]">Max Allowed</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {containerPolicies.map((cp: any, idx: number) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">{cp.container_name || '-'}</td>
                    <td className="py-2 pr-2 align-top">{cp.mode || '-'}</td>
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">
                      {Array.isArray(cp.controlled_resources) && cp.controlled_resources.length ? cp.controlled_resources.join(', ') : '-'}
                    </td>
                    <td className="py-2 pr-2 align-top break-all whitespace-normal">{cp.controlled_values || '-'}</td>
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
          {policyExtras.length > 0 && (
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-xs table-fixed min-w-[700px]">
                <thead className="text-slate-400">
                  <tr>
                    {VPA_POLICY_EXTRA_HEAD.map((h, i) => <Th key={h} className={`text-left py-2 ${['w-[15%]', 'w-[13%]', 'w-[13%]', 'w-[17%]', 'w-[17%]', 'w-[25%]'][i]}`}>{h}</Th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {policyExtras.map((row, idx) => (
                    <tr key={idx} className="text-slate-200">
                      {row.map((cell, i) => <td key={i} className="py-2 pr-2 align-top break-all whitespace-normal">{cell}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </InfoSection>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <InfoSection title="Recommendations">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[700px]">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-2 w-[18%]">Container</Th>
                  <Th className="text-left py-2 w-[18%]">Lower Bound</Th>
                  <Th className="text-left py-2 w-[18%]">Target</Th>
                  <Th className="text-left py-2 w-[18%]">Upper Bound</Th>
                  <Th className="text-left py-2 w-[28%]">Uncapped Target</Th>
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
      <EventsSection events={desc.events} error={desc.events_error} />

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
