import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

type ResourceSliceDescribe = {
  name?: string
  node_name?: string
  driver_name?: string
  uid?: string | null
  resource_version?: string | null
  pool?: Record<string, unknown>
  devices?: Array<Record<string, unknown>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
}

export default function ResourceSliceInfo({ name, rawJson }: Props) {
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['resourceslice-describe', name],
    queryFn: () => api.describeResourceSlice(name) as Promise<ResourceSliceDescribe>,
    enabled: !!name,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const nodeName = (describe?.node_name ?? (describe?.spec as Record<string, unknown> | undefined)?.nodeName) as string | undefined
  const driverName = (describe?.driver_name ?? (describe?.spec as Record<string, unknown> | undefined)?.driver) as string | undefined
  const pool = describe?.pool ?? (describe?.spec as Record<string, unknown> | undefined)?.pool
  const devices = describe?.devices ?? (describe?.spec as Record<string, unknown> | undefined)?.devices

  return (
    <>
      <InfoSection title="Slice Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading ResourceSlice details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          {nodeName && <InfoRow label="Node Name" value={String(nodeName)} />}
          {driverName && <InfoRow label="Driver Name" value={String(driverName)} />}
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      {pool && (
        <InfoSection title="Pool">
          <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-64">
            {JSON.stringify(pool, null, 2)}
          </pre>
        </InfoSection>
      )}

      <InfoSection title="Devices">
        {devices && (Array.isArray(devices) ? devices.length > 0 : true) ? (
          <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-64">
            {JSON.stringify(devices, null, 2)}
          </pre>
        ) : (
          <p className="text-xs text-slate-400">No devices</p>
        )}
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
