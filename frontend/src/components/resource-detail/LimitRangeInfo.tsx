import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, SummaryBadge, KeyValueTags, EventsSection, Th, NoneText, Tx } from './DetailCommon'
import { fmtRel } from './detailFormat'
import { limitRangeViolationsLayer, limitRangeViolationsSummary, violatingPodCount, violationsUnread } from './limitRangeViolations'
import { useDrawerFollowsObject } from './useDrawerFollowsObject'
import { usePagination } from './usePagination'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { DescribeFailure, DescribeStale } from './DescribeFailure'

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
  const { open: openDetail } = useResourceDetail()
  const { data: desc, isLoading, error: describeError, dataUpdatedAt } = useQuery({
    queryKey: ['limitrange-describe', namespace, name],
    queryFn: () => api.describeLimitRange(namespace, name),
    staleTime: 10_000,
    retry: 1,
  })
  useDrawerFollowsObject({
    enabled: !!namespace && !!name,
    describeKey: ['limitrange-describe', namespace, name],
    path: `/api/v1/namespaces/${namespace}/limitranges`,
    name,
    alsoRead: [['limitrange-violations', namespace, name]],
  })

  const { data: violations, error: violationsError } = useQuery({
    queryKey: ['limitrange-violations', namespace, name],
    queryFn: () => api.listPodsViolatingLimitRange(namespace, name),
    enabled: !!namespace && !!name,
    staleTime: 10_000,
    // a refusal is an answer: the window says it now, not a second later after asking again
    retry: (failures, error) => failures < 1 && (error as { response?: { status?: number } }).response?.status !== 403,
  })
  const violationList = Array.isArray(violations) ? violations : []
  const podCount = violatingPodCount(violationList)
  const { items: pagedViolations, nav: violationsNav } = usePagination(violationList, 10)

  const answered = Array.isArray(violations) ? violations : undefined
  const unread = useMemo(() => violationsUnread(violationsError), [violationsError])
  const violationsLayer = useMemo(() => limitRangeViolationsLayer(answered, unread), [answered, unread])
  useResourceDetailOverlay({
    kind: 'LimitRange',
    name,
    namespace,
    describe: desc,
    extras: violationsLayer,
    summary: limitRangeViolationsSummary(name, namespace, answered, unread),
  })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center"><Tx>Loading...</Tx></div>
  }

  if (!desc) {
    // a read that failed is not an object with no data
    if (describeError) return <DescribeFailure error={describeError} className="py-4" />
    return <div className="text-xs text-slate-400 py-4 text-center"><Tx>No data</Tx></div>
  }

  const limits: any[] = desc.limits || []
  const uniqueTypes = [...new Set(limits.map((l: any) => l.type).filter(Boolean))]

  return (
    <div className="space-y-4">
      <DescribeStale error={describeError} readAt={dataUpdatedAt} />
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Limit Types" value={limits.length} color="default" />
        {uniqueTypes.map(t => (
          <SummaryBadge key={t} label={t} value="active" color={typeColors[t] || 'default'} />
        ))}
        <SummaryBadge
          label="Violating Pods"
          value={answered ? podCount : '-'}
          color={!answered ? 'default' : podCount === 0 ? 'green' : podCount < 5 ? 'amber' : 'red'}
        />
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
              <div key={li} className="rounded-sm border border-slate-800 p-3">
                <p className="text-[11px] text-slate-400 mb-1">Type: {lim.type || '-'}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs table-fixed min-w-[480px]">
                    <thead className="text-slate-400">
                      <tr>
                        <Th className="text-left py-1 w-[20%]">Resource</Th>
                        <Th className="text-left py-1 w-[20%]">Min</Th>
                        <Th className="text-left py-1 w-[20%]">Max</Th>
                        <Th className="text-left py-1 w-[20%]">Default</Th>
                        <Th className="text-left py-1 w-[20%]">Default Request</Th>
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
        ) : <NoneText />}
      </InfoSection>

      <InfoSection title="Violating Pods ({{n}})" titleValues={{ n: answered ? podCount : '-' }}>
        {!answered && unread ? (
          <p className="text-xs text-red-400" data-testid="limitrange-violations-unread">
            <Tx>{unread.status === 403
              ? 'You may not read the pods of this namespace, so this window cannot say which of them violate this LimitRange.'
              : 'Could not read the pods of this namespace, so this window cannot say which of them violate this LimitRange.'}</Tx>
            {unread.detail && <span className="block mt-1 text-slate-400">{unread.detail}</span>}
          </p>
        ) : !answered ? (
          <p className="text-xs text-slate-400"><Tx>Loading...</Tx></p>
        ) : violationList.length === 0 ? (
          <p className="text-xs text-slate-400"><Tx>No pod in this namespace currently violates this LimitRange.</Tx></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1">Pod</Th>
                  <Th className="text-left py-1">Container</Th>
                  <Th className="text-left py-1">Field</Th>
                  <Th className="text-left py-1">Actual</Th>
                  <Th className="text-left py-1">Limit</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedViolations.map((v, i) => (
                  <tr
                    key={i}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => openDetail({ kind: 'Pod', name: v.pod, namespace: v.namespace })}
                  >
                    <td className="py-1 pr-2 font-mono">{v.pod}</td>
                    <td className="py-1 pr-2 font-mono">{v.container}</td>
                    <td className="py-1 pr-2 font-mono">{v.field}</td>
                    <td className="py-1 pr-2 font-mono text-amber-300">{v.actual}</td>
                    <td className="py-1 pr-2 font-mono">{v.limit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {violationsNav}
          </div>
        )}
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
