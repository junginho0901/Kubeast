import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { ConditionsTable, EventsSection, InfoSection, InfoRow, KeyValueTags, SummaryBadge, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { conditionStatus, conditionSummary } from './gatewayDetail'
import { useDrawerFollowsEvents } from './useDrawerFollowsEvents'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import type { GatewayClassInfo as GatewayClassRow } from '@/services/api'
import { DescribeFailure, DescribeStale } from './DescribeFailure'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

// the list's row (gatewayrow.GatewayClass) with the object's metadata, events and supported features
type GatewayClassDescribe = GatewayClassRow & {
  uid?: string | null
  resource_version?: string | null
  generation?: number
  events?: Array<Record<string, unknown>>
  events_error?: string
  supported_features?: Array<{ name?: string }>
}

function text(value: unknown): string {
  if (value == null) return '-'
  const s = String(value)
  return s.length > 0 ? s : '-'
}

function formatParametersRef(parametersRef: Record<string, unknown> | null | undefined): string {
  if (!parametersRef || typeof parametersRef !== 'object') return '-'
  const group = text(parametersRef.group)
  const kind = text(parametersRef.kind)
  const name = text(parametersRef.name)
  const namespace = text(parametersRef.namespace)

  const base = [kind, group !== '-' ? `.${group}` : '', name !== '-' ? `/${name}` : ''].join('')
  if (namespace !== '-') return `${base} (ns: ${namespace})`
  return base || '-'
}

export default function GatewayClassInfo({ name, rawJson }: Props) {
  const { data: describe, isLoading, error: describeError, dataUpdatedAt } = useQuery({
    queryKey: ['gatewayclass-describe', name],
    queryFn: () => api.describeGatewayClass(name) as Promise<GatewayClassDescribe>,
    enabled: !!name,
    retry: false,
  })
  useDrawerFollowsEvents({ describeKey: ['gatewayclass-describe', name], answer: describe, kind: 'GatewayClass', name })

  useResourceDetailOverlay({ kind: 'GatewayClass', name, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>

  const conditions = useMemo(() => {
    if (Array.isArray(describe?.conditions)) return describe.conditions
    return Array.isArray(status?.conditions) ? (status.conditions as Array<Record<string, unknown>>) : []
  }, [describe?.conditions, status?.conditions])

  const accepted = conditionStatus(conditions, 'Accepted')
  const statusText = describe?.status || conditionSummary(conditions, 'Accepted')

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const finalizers = Array.isArray(describe?.finalizers)
    ? describe.finalizers
    : (Array.isArray(meta?.finalizers) ? (meta.finalizers as string[]) : [])

  const parametersRef = (describe?.parameters_ref ?? spec?.parametersRef ?? null) as Record<string, unknown> | null
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)
  const controllerName = describe?.controller_name ?? (spec?.controllerName as string | undefined)

  return (
    <>
      <InfoSection title="GatewayClass Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2"><Tx>Loading gateway class details...</Tx></p>}
        <DescribeFailure error={describe ? null : describeError} showingRow className="mb-2" />
        <DescribeStale error={describeError} readAt={dataUpdatedAt} />
        <div className="flex flex-wrap gap-2 mb-3">
          <SummaryBadge label="Status" value={statusText} color="default" />
          <SummaryBadge label="Accepted" value={accepted} color={accepted === 'True' ? 'green' : 'amber'} />
        </div>
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Controller" value={controllerName || '-'} />
          <InfoRow label="Description" value={text(describe?.description ?? spec?.description)} />
          <InfoRow label="Parameters Ref" value={formatParametersRef(parametersRef)} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="Conditions">
        <ConditionsTable conditions={conditions as any[]} />
      </InfoSection>

      {Array.isArray(describe?.supported_features) && describe.supported_features.length > 0 && (
        <InfoSection title="Supported Features ({{n}})" titleValues={{ n: describe.supported_features.length }}>
          <div className="flex flex-wrap gap-1.5">
            {describe.supported_features.map((f, i) => (
              <span key={i} className="rounded-sm border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[11px] font-mono text-slate-200">
                {f?.name || '-'}
              </span>
            ))}
          </div>
        </InfoSection>
      )}

      <EventsSection events={describe?.events} error={describe?.events_error} loading={isLoading} />

      <InfoSection title="Lifecycle">
        <div className="space-y-2">
          <InfoRow label="UID" value={text(describe?.uid)} />
          <InfoRow label="Resource Version" value={text(describe?.resource_version)} />
          <InfoRow label="API Version" value={describe?.api_version || text(rawJson?.apiVersion)} />
          <InfoRow label="Finalizers" value={finalizers.join(', ') || '-'} />
        </div>
      </InfoSection>

      {Object.keys(labels).length > 0 && (
        <InfoSection title="Labels">
          <KeyValueTags data={labels} />
        </InfoSection>
      )}

      {Object.keys(annotations).length > 0 && (
        <InfoSection title="Annotations">
          <KeyValueTags data={annotations} />
        </InfoSection>
      )}
    </>
  )
}
