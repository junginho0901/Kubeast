import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, SummaryBadge, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

type ResourceClaimDescribe = {
  name?: string
  namespace?: string
  uid?: string | null
  resource_version?: string | null
  devices?: Record<string, unknown>
  allocation?: Record<string, unknown>
  reserved_for?: Array<Record<string, unknown>>
  allocation_status?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  metadata?: Record<string, unknown>
  status?: Record<string, unknown>
}

export default function ResourceClaimInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['resourceclaim-describe', namespace, name],
    queryFn: () => api.describeResourceClaim(namespace, name) as Promise<ResourceClaimDescribe>,
    enabled,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const allocationStatus = describe?.allocation_status
  const allocation = describe?.allocation ?? (describe?.status as Record<string, unknown> | undefined)?.allocation
  const reservedFor = describe?.reserved_for ?? (describe?.status as Record<string, unknown> | undefined)?.reservedFor as Array<Record<string, unknown>> | undefined

  return (
    <>
      <InfoSection title="Claim Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading ResourceClaim details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          <InfoRow label="Namespace" value={describe?.namespace || namespace} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {allocationStatus && (
            <InfoRow label="Allocation Status" value={<SummaryBadge label="Status" value={allocationStatus} color={allocationStatus.toLowerCase() === 'allocated' ? 'green' : 'default'} />} />
          )}
        </div>
      </InfoSection>

      {describe?.devices && (
        <InfoSection title="Devices">
          <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-64">
            {JSON.stringify(describe.devices, null, 2)}
          </pre>
        </InfoSection>
      )}

      {allocation && (
        <InfoSection title="Allocation">
          <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-64">
            {JSON.stringify(allocation, null, 2)}
          </pre>
        </InfoSection>
      )}

      {reservedFor && Array.isArray(reservedFor) && reservedFor.length > 0 && (
        <InfoSection title="Reserved For">
          <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-64">
            {JSON.stringify(reservedFor, null, 2)}
          </pre>
        </InfoSection>
      )}

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
