import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { InfoSection, InfoRow, InfoGrid, SummaryBadge, KeyValueTags, ConditionsTable, EventsSection, StatusBadge, Th, Tx } from './DetailCommon'
import { fmtRel } from './detailFormat'
import { useDrawerFollowsObject } from './useDrawerFollowsObject'
import { useDrawerFollowsEvents } from './useDrawerFollowsEvents'
import { selectorText } from './netpolText'
import { useNamespacePodTable } from './useNamespacePodTable'
import { SET_POD_TABLE_WATCH_MAX } from './namespacePodTable'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { podTableStatus } from '@/pages/workloads/pods/podHelpers'
import { DescribeFailure, DescribeStale } from './DescribeFailure'

// The API server applies the selector to the whole read: every row it gives is a match.
const keepEvery = () => true

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function PDBInfo({ name, namespace }: Props) {
  const { open: openDetail } = useResourceDetail()
  const { data: desc, isLoading, error: describeError, dataUpdatedAt } = useQuery({
    queryKey: ['pdb-describe', namespace, name],
    queryFn: () => api.describePDB(namespace, name),
    staleTime: 10_000,
    retry: 1,
  })
  useDrawerFollowsObject({
    enabled: !!namespace && !!name,
    describeKey: ['pdb-describe', namespace, name],
    path: `/apis/policy/v1/namespaces/${namespace}/poddisruptionbudgets`,
    name,
  })
  useDrawerFollowsEvents({ describeKey: ['pdb-describe', namespace, name], answer: desc, kind: 'PodDisruptionBudget', namespace, name })

  useResourceDetailOverlay({ kind: 'PodDisruptionBudget', name, namespace, describe: desc })

  // matchExpressions too, as the disruption controller reads the budget's selector
  const selectorStr = useMemo(
    () => selectorText({ matchLabels: desc?.selector, matchExpressions: desc?.match_expressions }),
    [desc?.selector, desc?.match_expressions],
  )
  // policy/v1: no selector protects no pod, an empty one every pod of the namespace; a server that does not say is read as before
  const hasSelector = desc?.has_selector as boolean | undefined
  const protectedEnabled = !!namespace && hasSelector !== false && (hasSelector === true || !!selectorStr)

  const protectedPods = useNamespacePodTable({
    enabled: protectedEnabled,
    namespace,
    filter: selectorStr ? { label_selector: selectorStr } : {},
    queryKey: ['pdb-protected-pods', namespace, name, selectorStr],
    keeps: keepEvery,
    selector: selectorStr,
    line: SET_POD_TABLE_WATCH_MAX,
  })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center"><Tx>Loading...</Tx></div>
  }

  if (!desc) {
    // a read that failed is not an object with no data
    if (describeError) return <DescribeFailure error={describeError} className="py-4" />
    return <div className="text-xs text-slate-400 py-4 text-center"><Tx>No data</Tx></div>
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
  const unhealthyPodEvictionPolicy = desc.unhealthy_pod_eviction_policy || null

  const isHealthy = disruptionsAllowed > 0 || currentHealthy >= desiredHealthy

  return (
    <div className="space-y-4">
      <DescribeStale error={describeError} readAt={dataUpdatedAt} />
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
                  <Th className="text-left py-2 w-[30%]">Key</Th>
                  <Th className="text-left py-2 w-[20%]">Operator</Th>
                  <Th className="text-left py-2 w-[50%]">Values</Th>
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

      {/* Protected Pods (live) */}
      {hasSelector === false && (
        <InfoSection title="Protected Pods ({{n}})" titleValues={{ n: 0 }}>
          <p className="text-xs text-slate-400"><Tx>This PodDisruptionBudget has no selector, so it protects no pod.</Tx></p>
        </InfoSection>
      )}
      {protectedEnabled && (
        <InfoSection title="Protected Pods ({{n}})" titleValues={{ n: protectedPods.total }}>
          {!selectorStr && <p className="mb-2 text-xs text-slate-400"><Tx>The selector is empty, so this PodDisruptionBudget protects every pod of its namespace.</Tx></p>}
          {protectedPods.note}
          {protectedPods.loading ? (
            <p className="text-xs text-slate-400"><Tx>Loading...</Tx></p>
          ) : protectedPods.total === 0 ? (
            <p className="text-xs text-slate-400"><Tx>No pod matches this selector.</Tx></p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <Th className="text-left py-1">Pod</Th>
                    <Th className="text-left py-1">Status</Th>
                    <Th className="text-left py-1">Ready</Th>
                    <Th className="text-left py-1">Node</Th>
                    <Th className="text-left py-1">Age</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {protectedPods.items.map((p: any) => (
                    <tr
                      key={`${p.namespace}/${p.name}`}
                      className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                      onClick={() => openDetail({ kind: 'Pod', name: p.name, namespace: p.namespace })}
                    >
                      <td className="py-1 pr-2 font-mono">{p.name}</td>
                      <td className="py-1 pr-2"><StatusBadge status={podTableStatus(p)} /></td>
                      <td className="py-1 pr-2">{p.ready ?? '-'}</td>
                      <td className="py-1 pr-2 truncate max-w-[160px]">{p.node_name || '-'}</td>
                      <td className="py-1 pr-2 text-slate-400">{fmtRel(p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {protectedPods.nav}
            </div>
          )}
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
