import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { ConditionsTable, InfoSection, InfoRow, KeyValueTags, SummaryBadge, fmtRel, fmtTs } from './DetailCommon'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

type GatewayClassDescribe = {
  uid?: string | null
  resource_version?: string | null
  controller_name?: string | null
  description?: string | null
  accepted?: boolean
  status?: string | null
  parameters_ref?: Record<string, unknown> | null
  conditions?: Array<Record<string, unknown>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
  apiVersion?: string
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
  status_detail?: Record<string, unknown>
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
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['gatewayclass-describe', name],
    queryFn: () => api.describeGatewayClass(name) as Promise<GatewayClassDescribe>,
    enabled: !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'GatewayClass', name, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>

  const conditions = useMemo(() => {
    if (Array.isArray(describe?.conditions)) return describe.conditions
    if (Array.isArray((describe?.status_detail as any)?.conditions)) return (describe?.status_detail as any).conditions
    return Array.isArray(status?.conditions) ? (status.conditions as Array<Record<string, unknown>>) : []
  }, [describe?.conditions, describe?.status_detail, status?.conditions])

  const accepted = Boolean(
    describe?.accepted
    || conditions.some((c: any) => String(c?.type) === 'Accepted' && String(c?.status).toLowerCase() === 'true'),
  )

  const statusText = describe?.status || (
    accepted
      ? 'Accepted'
      : (() => {
          const firstTrue = conditions.find((c: any) => String(c?.status).toLowerCase() === 'true')
          if (firstTrue?.type) return String(firstTrue.type)
          const firstFalse = conditions.find((c: any) => String(c?.status).toLowerCase() === 'false')
          if (firstFalse?.type) return `${String(firstFalse.type)}(False)`
          return 'Unknown'
        })()
  )

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
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading gateway class details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="flex flex-wrap gap-2 mb-3">
          <SummaryBadge label="Status" value={statusText} color="default" />
          <SummaryBadge label="Accepted" value={accepted ? 'Yes' : 'No'} color={accepted ? 'green' : 'amber'} />
        </div>
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Controller" value={controllerName || '-'} />
          <InfoRow label="Description" value={describe?.description || text(annotations['gateway.networking.k8s.io/description'])} />
          <InfoRow label="Parameters Ref" value={formatParametersRef(parametersRef)} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="Conditions">
        <ConditionsTable conditions={conditions as any[]} />
      </InfoSection>

      <InfoSection title="Lifecycle">
        <div className="space-y-2">
          <InfoRow label="UID" value={describe?.uid || text((describe?.metadata as any)?.uid)} />
          <InfoRow label="Resource Version" value={describe?.resource_version || text((describe?.metadata as any)?.resourceVersion)} />
          <InfoRow label="API Version" value={describe?.apiVersion || text(rawJson?.apiVersion)} />
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
