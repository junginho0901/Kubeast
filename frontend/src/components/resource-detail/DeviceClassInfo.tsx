import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

type DeviceClassDescribe = {
  name?: string
  uid?: string | null
  resource_version?: string | null
  selectors?: Array<Record<string, unknown>>
  suitable_nodes?: Record<string, unknown>
  config?: Record<string, unknown>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  metadata?: Record<string, unknown>
}

export default function DeviceClassInfo({ name, rawJson }: Props) {
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['deviceclass-describe', name],
    queryFn: () => api.describeDeviceClass(name) as Promise<DeviceClassDescribe>,
    enabled: !!name,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  return (
    <>
      <InfoSection title="DeviceClass Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading DeviceClass details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="Selectors">
        {describe?.selectors && describe.selectors.length > 0 ? (
          <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-64">
            {JSON.stringify(describe.selectors, null, 2)}
          </pre>
        ) : (
          <p className="text-xs text-slate-400">No selectors</p>
        )}
      </InfoSection>

      {describe?.suitable_nodes && (
        <InfoSection title="Suitable Nodes">
          <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-64">
            {JSON.stringify(describe.suitable_nodes, null, 2)}
          </pre>
        </InfoSection>
      )}

      {describe?.config && (
        <InfoSection title="Config">
          <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-64">
            {JSON.stringify(describe.config, null, 2)}
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
